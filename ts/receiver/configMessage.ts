import _, { compact, isEmpty, toNumber } from 'lodash';
import { ConfigDumpData } from '../data/configDump/configDump';
import { Data, hasSyncedInitialConfigurationItem } from '../data/data';
import { ConversationInteraction } from '../interactions';
import { ConversationTypeEnum } from '../models/conversationAttributes';
import { SignalService } from '../protobuf';
import { ClosedGroup } from '../session';
import {
  joinOpenGroupV2WithUIEvents,
  parseOpenGroupV2,
} from '../session/apis/open_group_api/opengroupV2/JoinOpenGroupV2';
import { getOpenGroupManager } from '../session/apis/open_group_api/opengroupV2/OpenGroupManagerV2';
import { OpenGroupUtils } from '../session/apis/open_group_api/utils';
import { getOpenGroupV2ConversationId } from '../session/apis/open_group_api/utils/OpenGroupUtils';
import { getConversationController } from '../session/conversations';
import { IncomingMessage } from '../session/messages/incoming/IncomingMessage';
import { ProfileManager } from '../session/profile_manager/ProfileManager';
import { UserUtils } from '../session/utils';
import { ConfigurationSync } from '../session/utils/job_runners/jobs/ConfigurationSyncJob';
import { IncomingConfResult, LibSessionUtil } from '../session/utils/libsession/libsession_utils';
import { SessionUtilConvoInfoVolatile } from '../session/utils/libsession/libsession_utils_convo_info_volatile';
import { SessionUtilUserGroups } from '../session/utils/libsession/libsession_utils_user_groups';
import { toHex } from '../session/utils/String';
import { configurationMessageReceived, trigger } from '../shims/events';
import { assertUnreachable } from '../types/sqlSharedTypes';
import { BlockedNumberController } from '../util';
import { Registration } from '../util/registration';
import { getLastProfileUpdateTimestamp, setLastProfileUpdateTimestamp } from '../util/storage';
import { ConfigWrapperObjectTypes } from '../webworker/workers/browser/libsession_worker_functions';
import {
  ContactsWrapperActions,
  ConvoInfoVolatileWrapperActions,
  GenericWrapperActions,
  UserConfigWrapperActions,
  UserGroupsWrapperActions,
} from '../webworker/workers/browser/libsession_worker_interface';
import { removeFromCache } from './cache';
import { addKeyPairToCacheAndDBIfNeeded, handleNewClosedGroup } from './closedGroups';
import { HexKeyPair } from './keypairs';
import { EnvelopePlus } from './types';

function groupByVariant(
  incomingConfigs: Array<IncomingMessage<SignalService.ISharedConfigMessage>>
) {
  const groupedByVariant: Map<
    ConfigWrapperObjectTypes,
    Array<IncomingMessage<SignalService.ISharedConfigMessage>>
  > = new Map();

  incomingConfigs.forEach(incomingConfig => {
    const { kind } = incomingConfig.message;

    const wrapperId = LibSessionUtil.kindToVariant(kind);

    if (!groupedByVariant.has(wrapperId)) {
      groupedByVariant.set(wrapperId, []);
    }

    groupedByVariant.get(wrapperId)?.push(incomingConfig);
  });
  return groupedByVariant;
}

async function mergeConfigsWithIncomingUpdates(
  incomingConfigs: Array<IncomingMessage<SignalService.ISharedConfigMessage>>
): Promise<Map<ConfigWrapperObjectTypes, IncomingConfResult>> {
  // first, group by variant so we do a single merge call
  const groupedByVariant = groupByVariant(incomingConfigs);

  const groupedResults: Map<ConfigWrapperObjectTypes, IncomingConfResult> = new Map();

  // TODOLATER currently we only poll for user config messages, so this can be hardcoded
  const publicKey = UserUtils.getOurPubKeyStrFromCache();

  try {
    for (let index = 0; index < groupedByVariant.size; index++) {
      const variant = [...groupedByVariant.keys()][index];
      const sameVariant = groupedByVariant.get(variant);
      if (!sameVariant?.length) {
        continue;
      }
      const toMerge = sameVariant.map(msg => ({
        data: msg.message.data,
        hash: msg.messageHash,
      }));

      await GenericWrapperActions.merge(variant, toMerge);
      const needsPush = await GenericWrapperActions.needsPush(variant);
      const needsDump = await GenericWrapperActions.needsDump(variant);
      const latestEnvelopeTimestamp = Math.max(...sameVariant.map(m => m.envelopeTimestamp));

      window.log.info(`${variant}: "${publicKey}" needsPush:${needsPush} needsDump:${needsDump} `);

      const incomingConfResult: IncomingConfResult = {
        needsDump,
        needsPush,
        kind: LibSessionUtil.variantToKind(variant),
        publicKey,
        latestEnvelopeTimestamp: latestEnvelopeTimestamp ? latestEnvelopeTimestamp : Date.now(),
      };
      groupedResults.set(variant, incomingConfResult);
    }

    return groupedResults;
  } catch (e) {
    window.log.error('mergeConfigsWithIncomingUpdates failed with', e);
    throw e;
  }
}

async function handleUserProfileUpdate(result: IncomingConfResult): Promise<IncomingConfResult> {
  const updatedUserName = await UserConfigWrapperActions.getName();
  if (!result.needsDump) {
    return result;
  }

  const updatedProfilePicture = await UserConfigWrapperActions.getProfilePicture();
  const picUpdate = !isEmpty(updatedProfilePicture.key) && !isEmpty(updatedProfilePicture.url);

  await updateOurProfileLegacyOrViaLibSession(
    result.latestEnvelopeTimestamp,
    updatedUserName,
    picUpdate ? updatedProfilePicture.url : null,
    picUpdate ? updatedProfilePicture.key : null
  );
  return result;
}

// tslint:disable-next-line: cyclomatic-complexity
async function handleContactsUpdate(result: IncomingConfResult): Promise<IncomingConfResult> {
  if (!result.needsDump) {
    return result;
  }
  const us = UserUtils.getOurPubKeyStrFromCache();

  const allContacts = await ContactsWrapperActions.getAll();

  for (let index = 0; index < allContacts.length; index++) {
    const wrapperConvo = allContacts[index];

    if (wrapperConvo.id === us) {
      // our profile update comes from our userProfile, not from the contacts wrapper.
      continue;
    }

    const contactConvo = await getConversationController().getOrCreateAndWait(
      wrapperConvo.id,
      ConversationTypeEnum.PRIVATE
    );
    if (wrapperConvo.id && contactConvo) {
      let changes = false;

      // the display name set is handled in `updateProfileOfContact`
      if (wrapperConvo.nickname !== contactConvo.getNickname()) {
        await contactConvo.setNickname(wrapperConvo.nickname || null, false);
        changes = true;
      }

      if (wrapperConvo.priority !== contactConvo.get('priority')) {
        await contactConvo.setPriorityFromWrapper(wrapperConvo.priority);
        changes = true;
      }

      if (Boolean(wrapperConvo.approved) !== Boolean(contactConvo.isApproved())) {
        await contactConvo.setIsApproved(Boolean(wrapperConvo.approved), false);
        changes = true;
      }

      if (Boolean(wrapperConvo.approvedMe) !== Boolean(contactConvo.didApproveMe())) {
        await contactConvo.setDidApproveMe(Boolean(wrapperConvo.approvedMe), false);
        changes = true;
      }

      if (wrapperConvo.expirationTimerSeconds !== contactConvo.get('expireTimer')) {
        await contactConvo.updateExpireTimer(wrapperConvo.expirationTimerSeconds);
        changes = true;
      }

      const convoBlocked = wrapperConvo.blocked || false;
      await BlockedNumberController.setBlocked(wrapperConvo.id, convoBlocked);

      // make sure to write the changes to the database now as the `AvatarDownloadJob` below might take some time before getting run
      if (changes) {
        await contactConvo.commit();
      }

      // we still need to handle the `name` (synchronous) and the `profilePicture` (asynchronous)
      await ProfileManager.updateProfileOfContact(
        contactConvo.id,
        wrapperConvo.name,
        wrapperConvo.profilePicture?.url || null,
        wrapperConvo.profilePicture?.key || null
      );
    }
  }
  return result;
}

async function handleCommunitiesUpdate() {
  // first let's check which communities needs to be joined or left by doing a diff of what is in the wrapper and what is in the DB

  const allCommunitiesInWrapper = await UserGroupsWrapperActions.getAllCommunities();
  const allCommunitiesConversation = getConversationController()
    .getConversations()
    .filter(SessionUtilUserGroups.isCommunityToStoreInWrapper);

  const allCommunitiesIdsInDB = allCommunitiesConversation.map(m => m.id as string);

  const communitiesIdsInWrapper = compact(
    allCommunitiesInWrapper.map(m => {
      try {
        const builtConvoId = OpenGroupUtils.getOpenGroupV2ConversationId(
          m.baseUrl,
          m.roomCasePreserved
        );
        return builtConvoId;
      } catch (e) {
        return null;
      }
    })
  );

  const communitiesToJoinInDB = compact(
    allCommunitiesInWrapper.map(m => {
      try {
        const builtConvoId = OpenGroupUtils.getOpenGroupV2ConversationId(
          m.baseUrl,
          m.roomCasePreserved
        );
        return allCommunitiesIdsInDB.includes(builtConvoId) ? null : m;
      } catch (e) {
        return null;
      }
    })
  );

  const communitiesToLeaveInDB = compact(
    allCommunitiesConversation.map(m => {
      return communitiesIdsInWrapper.includes(m.id) ? null : m;
    })
  );

  for (let index = 0; index < communitiesToLeaveInDB.length; index++) {
    const toLeave = communitiesToLeaveInDB[index];
    console.warn('leaving community with convoId ', toLeave.id);
    await getConversationController().deleteContact(toLeave.id, true);
  }

  // this call can take quite a long time and should not cause issues to not be awaited
  void Promise.all(
    communitiesToJoinInDB.map(async toJoin => {
      console.warn('joining community with convoId ', toJoin.fullUrl);
      return getOpenGroupManager().attemptConnectionV2OneAtATime(
        toJoin.baseUrl,
        toJoin.roomCasePreserved,
        toJoin.pubkeyHex
      );
    })
  );

  // if the convos already exists, make sure to update the fields if needed
  for (let index = 0; index < allCommunitiesInWrapper.length; index++) {
    const fromWrapper = allCommunitiesInWrapper[index];
    const convoId = OpenGroupUtils.getOpenGroupV2ConversationId(
      fromWrapper.baseUrl,
      fromWrapper.roomCasePreserved
    );

    const communityConvo = getConversationController().get(convoId);
    if (fromWrapper && communityConvo) {
      let changes = false;

      changes =
        (await communityConvo.setPriorityFromWrapper(fromWrapper.priority, false)) || changes;

      // make sure to write the changes to the database now as the `AvatarDownloadJob` below might take some time before getting run
      if (changes) {
        await communityConvo.commit();
      }
    }
  }
}

async function handleLegacyGroupUpdate(latestEnvelopeTimestamp: number) {
  // first let's check which closed groups needs to be joined or left by doing a diff of what is in the wrapper and what is in the DB
  const allLegacyGroupsInWrapper = await UserGroupsWrapperActions.getAllLegacyGroups();
  const allLegacyGroupsInDb = getConversationController()
    .getConversations()
    .filter(SessionUtilUserGroups.isLegacyGroupToStoreInWrapper);

  const allLegacyGroupsIdsInDB = allLegacyGroupsInDb.map(m => m.id as string);
  const allLegacyGroupsIdsInWrapper = allLegacyGroupsInWrapper.map(m => m.pubkeyHex);

  const legacyGroupsToJoinInDB = allLegacyGroupsInWrapper.filter(m => {
    return !allLegacyGroupsIdsInDB.includes(m.pubkeyHex);
  });

  const legacyGroupsToLeaveInDB = allLegacyGroupsInDb.filter(m => {
    return !allLegacyGroupsIdsInWrapper.includes(m.id);
  });
  window.log.info(
    `we have to join ${legacyGroupsToJoinInDB.length} legacy groups in DB compared to what is in the wrapper`
  );

  window.log.info(
    `we have to leave ${legacyGroupsToLeaveInDB.length} legacy groups in DB compared to what is in the wrapper`
  );

  for (let index = 0; index < legacyGroupsToLeaveInDB.length; index++) {
    const toLeave = legacyGroupsToLeaveInDB[index];
    console.warn('leaving legacy group from configuration sync message with convoId ', toLeave.id);
    await getConversationController().deleteContact(toLeave.id, true);
  }

  for (let index = 0; index < legacyGroupsToJoinInDB.length; index++) {
    const toJoin = legacyGroupsToJoinInDB[index];
    console.warn(
      'joining legacy group from configuration sync message with convoId ',
      toJoin.pubkeyHex
    );

    // let's just create the required convo here, as we update the fields right below
    await getConversationController().getOrCreateAndWait(
      toJoin.pubkeyHex,
      ConversationTypeEnum.GROUP
    );
  }
  for (let index = 0; index < allLegacyGroupsInWrapper.length; index++) {
    const fromWrapper = allLegacyGroupsInWrapper[index];

    const legacyGroupConvo = getConversationController().get(fromWrapper.pubkeyHex);
    if (!legacyGroupConvo) {
      // this should not happen as we made sure to create them before
      window.log.warn(
        'could not find legacy group which should already be there:',
        fromWrapper.pubkeyHex
      );
      continue;
    }

    const members = fromWrapper.members.map(m => m.pubkeyHex);
    const admins = fromWrapper.members.filter(m => m.isAdmin).map(m => m.pubkeyHex);
    // then for all the existing legacy group in the wrapper, we need to override the field of what we have in the DB with what is in the wrapper
    // We only set group admins on group creation
    const groupDetails: ClosedGroup.GroupInfo = {
      id: fromWrapper.pubkeyHex,
      name: fromWrapper.name,
      members,
      admins,
      activeAt:
        !!legacyGroupConvo.get('active_at') &&
        legacyGroupConvo.get('active_at') < latestEnvelopeTimestamp
          ? legacyGroupConvo.get('active_at')
          : latestEnvelopeTimestamp,
      weWereJustAdded: false, // TODOLATER to remove once legacy groups support is dropped
    };

    await ClosedGroup.updateOrCreateClosedGroup(groupDetails);

    let changes = await legacyGroupConvo.setPriorityFromWrapper(fromWrapper.priority, false);

    if (legacyGroupConvo.get('priority') !== fromWrapper.priority) {
      legacyGroupConvo.set({ priority: fromWrapper.priority });
      changes = true;
    }
    if (legacyGroupConvo.get('expireTimer') !== fromWrapper.disappearingTimerSeconds) {
      await legacyGroupConvo.updateExpireTimer(
        fromWrapper.disappearingTimerSeconds,
        undefined,
        latestEnvelopeTimestamp,
        {
          fromSync: true,
        }
      );
      changes = true;
    }

    if (changes) {
      await legacyGroupConvo.commit();
    }

    // save the encryption keypair if needed
    if (!isEmpty(fromWrapper.encPubkey) && !isEmpty(fromWrapper.encSeckey)) {
      try {
        const inWrapperKeypair: HexKeyPair = {
          publicHex: toHex(fromWrapper.encPubkey),
          privateHex: toHex(fromWrapper.encSeckey),
        };

        await addKeyPairToCacheAndDBIfNeeded(fromWrapper.pubkeyHex, inWrapperKeypair);
      } catch (e) {
        window.log.warn('failed to save keypair for legacugroup', fromWrapper.pubkeyHex);
      }
    }
  }
}

async function handleUserGroupsUpdate(result: IncomingConfResult): Promise<IncomingConfResult> {
  if (!result.needsDump) {
    return result;
  }

  const toHandle = SessionUtilUserGroups.getUserGroupTypes();
  for (let index = 0; index < toHandle.length; index++) {
    const typeToHandle = toHandle[index];
    switch (typeToHandle) {
      case 'Community':
        await handleCommunitiesUpdate();
        break;

      case 'LegacyGroup':
        await handleLegacyGroupUpdate(result.latestEnvelopeTimestamp);
        break;

      default:
        assertUnreachable(typeToHandle, `handleUserGroupsUpdate unhandled type "${typeToHandle}"`);
    }
  }

  return result;
}

async function applyConvoVolatileUpdateFromWrapper(
  convoId: string,
  forcedUnread: boolean,
  lastReadMessageTimestamp: number
) {
  const foundConvo = getConversationController().get(convoId);
  if (!foundConvo) {
    return;
  }

  try {
    window.log.debug(
      `applyConvoVolatileUpdateFromWrapper: ${convoId}: forcedUnread:${forcedUnread}, lastReadMessage:${lastReadMessageTimestamp}`
    );
    // this should mark all the messages sent before fromWrapper.lastRead as read and update the unreadCount
    await foundConvo.markReadFromConfigMessage(lastReadMessageTimestamp);
    // this commits to the DB, if needed
    await foundConvo.markAsUnread(forcedUnread, true);

    if (SessionUtilConvoInfoVolatile.isConvoToStoreInWrapper(foundConvo)) {
      await SessionUtilConvoInfoVolatile.refreshConvoVolatileCached(
        foundConvo.id,
        foundConvo.isClosedGroup(),
        false
      );

      await foundConvo.refreshInMemoryDetails();
    }
  } catch (e) {
    window.log.warn(
      `applyConvoVolatileUpdateFromWrapper of "${convoId}" failed with error ${e.message}`
    );
  }
}

async function handleConvoInfoVolatileUpdate(
  result: IncomingConfResult
): Promise<IncomingConfResult> {
  if (!result.needsDump) {
    return result;
  }

  const types = SessionUtilConvoInfoVolatile.getConvoInfoVolatileTypes();
  for (let typeIndex = 0; typeIndex < types.length; typeIndex++) {
    const type = types[typeIndex];
    switch (type) {
      case '1o1':
        try {
          // Note: "Note to Self" comes here too
          const wrapper1o1s = await ConvoInfoVolatileWrapperActions.getAll1o1();
          for (let index = 0; index < wrapper1o1s.length; index++) {
            const fromWrapper = wrapper1o1s[index];
            await applyConvoVolatileUpdateFromWrapper(
              fromWrapper.pubkeyHex,
              fromWrapper.unread,
              fromWrapper.lastRead
            );
          }
        } catch (e) {
          window.log.warn('handleConvoInfoVolatileUpdate of "1o1" failed with error: ', e.message);
        }

        break;
      case 'Community':
        try {
          const wrapperComms = await ConvoInfoVolatileWrapperActions.getAllCommunities();
          for (let index = 0; index < wrapperComms.length; index++) {
            const fromWrapper = wrapperComms[index];

            const convoId = getOpenGroupV2ConversationId(
              fromWrapper.baseUrl,
              fromWrapper.roomCasePreserved
            );

            await applyConvoVolatileUpdateFromWrapper(
              convoId,
              fromWrapper.unread,
              fromWrapper.lastRead
            );
          }
        } catch (e) {
          window.log.warn(
            'handleConvoInfoVolatileUpdate of "Community" failed with error: ',
            e.message
          );
        }
        break;

      case 'LegacyGroup':
        try {
          const legacyGroups = await ConvoInfoVolatileWrapperActions.getAllLegacyGroups();
          for (let index = 0; index < legacyGroups.length; index++) {
            const fromWrapper = legacyGroups[index];

            await applyConvoVolatileUpdateFromWrapper(
              fromWrapper.pubkeyHex,
              fromWrapper.unread,
              fromWrapper.lastRead
            );
          }
        } catch (e) {
          window.log.warn(
            'handleConvoInfoVolatileUpdate of "LegacyGroup" failed with error: ',
            e.message
          );
        }
        break;

      default:
        assertUnreachable(type, `handleConvoInfoVolatileUpdate: unhandeld switch case: ${type}`);
    }
  }

  return result;
}

async function processMergingResults(results: Map<ConfigWrapperObjectTypes, IncomingConfResult>) {
  if (!results || !results.size) {
    return;
  }

  const keys = [...results.keys()];
  let anyNeedsPush = false;
  for (let index = 0; index < keys.length; index++) {
    const wrapperType = keys[index];
    const incomingResult = results.get(wrapperType);
    if (!incomingResult) {
      continue;
    }

    try {
      const { kind } = incomingResult;
      switch (kind) {
        case SignalService.SharedConfigMessage.Kind.USER_PROFILE:
          await handleUserProfileUpdate(incomingResult);
          break;
        case SignalService.SharedConfigMessage.Kind.CONTACTS:
          await handleContactsUpdate(incomingResult);
          break;
        case SignalService.SharedConfigMessage.Kind.USER_GROUPS:
          await handleUserGroupsUpdate(incomingResult);
          break;
        case SignalService.SharedConfigMessage.Kind.CONVO_INFO_VOLATILE:
          await handleConvoInfoVolatileUpdate(incomingResult);
          break;
        default:
          try {
            assertUnreachable(kind, `processMergingResults unsupported kind: "${kind}"`);
          } catch (e) {
            window.log.warn('assertUnreachable failed', e.message);
          }
      }
      const variant = LibSessionUtil.kindToVariant(kind);

      if (incomingResult.needsDump) {
        // The config data had changes so regenerate the dump and save it

        const dump = await GenericWrapperActions.dump(variant);
        await ConfigDumpData.saveConfigDump({
          data: dump,
          publicKey: incomingResult.publicKey,
          variant,
        });
      }

      if (incomingResult.needsPush) {
        anyNeedsPush = true;
      }
    } catch (e) {
      window.log.error(`processMergingResults failed with ${e.message}`);
      return;
    }
  }
  // Now that the local state has been updated, trigger a config sync (this will push any
  // pending updates and properly update the state)
  if (anyNeedsPush) {
    await ConfigurationSync.queueNewJobIfNeeded();
  }
}

async function handleConfigMessagesViaLibSession(
  configMessages: Array<IncomingMessage<SignalService.ISharedConfigMessage>>
) {
  if (!window.sessionFeatureFlags.useSharedUtilForUserConfig) {
    return;
  }

  if (isEmpty(configMessages)) {
    return;
  }

  window?.log?.info(
    `Handling our sharedConfig message via libsession_util: ${configMessages.length}`
  );

  const incomingMergeResult = await mergeConfigsWithIncomingUpdates(configMessages);

  await processMergingResults(incomingMergeResult);
}

async function updateOurProfileLegacyOrViaLibSession(
  sentAt: number,
  displayName: string,
  profileUrl: string | null,
  profileKey: Uint8Array | null
) {
  await ProfileManager.updateOurProfileSync(displayName, profileUrl, profileKey);

  await setLastProfileUpdateTimestamp(toNumber(sentAt));
  // do not trigger a signin by linking if the display name is empty
  if (!isEmpty(displayName)) {
    trigger(configurationMessageReceived, displayName);
  } else {
    window?.log?.warn('Got a configuration message but the display name is empty');
  }
}

async function handleOurProfileUpdateLegacy(
  sentAt: number | Long,
  configMessage: SignalService.ConfigurationMessage
) {
  // we want to allow if we are not registered, as we might need to fetch an old config message (can be removed once we released for a weeks the libsession util)
  if (window.sessionFeatureFlags.useSharedUtilForUserConfig && Registration.isDone()) {
    return;
  }
  const latestProfileUpdateTimestamp = getLastProfileUpdateTimestamp();
  if (!latestProfileUpdateTimestamp || sentAt > latestProfileUpdateTimestamp) {
    window?.log?.info(
      `Handling our profileUdpate ourLastUpdate:${latestProfileUpdateTimestamp}, envelope sent at: ${sentAt}`
    );
    const { profileKey, profilePicture, displayName } = configMessage;

    await updateOurProfileLegacyOrViaLibSession(
      toNumber(sentAt),
      displayName,
      profilePicture,
      profileKey
    );
  }
}

async function handleGroupsAndContactsFromConfigMessageLegacy(
  envelope: EnvelopePlus,
  configMessage: SignalService.ConfigurationMessage
) {
  if (window.sessionFeatureFlags.useSharedUtilForUserConfig && Registration.isDone()) {
    return;
  }
  const envelopeTimestamp = toNumber(envelope.timestamp);
  const lastConfigUpdate = await Data.getItemById(hasSyncedInitialConfigurationItem);
  const lastConfigTimestamp = lastConfigUpdate?.timestamp;
  const isNewerConfig =
    !lastConfigTimestamp || (lastConfigTimestamp && lastConfigTimestamp < envelopeTimestamp);

  if (!isNewerConfig) {
    window?.log?.info('Received outdated configuration message... Dropping message.');
    return;
  }

  await Data.createOrUpdateItem({
    id: 'hasSyncedInitialConfigurationItem',
    value: true,
    timestamp: envelopeTimestamp,
  });

  // we only want to apply changes to closed groups if we never got them
  // new opengroups get added when we get a new closed group message from someone, or a sync'ed message from outself creating the group
  if (!lastConfigTimestamp) {
    await handleClosedGroupsFromConfigLegacy(configMessage.closedGroups, envelope);
  }

  handleOpenGroupsFromConfig(configMessage.openGroups);

  if (configMessage.contacts?.length) {
    await Promise.all(
      configMessage.contacts.map(async c => handleContactFromConfigLegacy(c, envelope))
    );
  }
}

/**
 * Trigger a join for all open groups we are not already in.
 * @param openGroups string array of open group urls
 */
const handleOpenGroupsFromConfig = (openGroups: Array<string>) => {
  if (window.sessionFeatureFlags.useSharedUtilForUserConfig && Registration.isDone()) {
    return;
  }
  const numberOpenGroup = openGroups?.length || 0;
  for (let i = 0; i < numberOpenGroup; i++) {
    const currentOpenGroupUrl = openGroups[i];
    const parsedRoom = parseOpenGroupV2(currentOpenGroupUrl);
    if (!parsedRoom) {
      continue;
    }
    const roomConvoId = getOpenGroupV2ConversationId(parsedRoom.serverUrl, parsedRoom.roomId);
    if (!getConversationController().get(roomConvoId)) {
      window?.log?.info(
        `triggering join of public chat '${currentOpenGroupUrl}' from ConfigurationMessage`
      );
      void joinOpenGroupV2WithUIEvents(currentOpenGroupUrl, false, true);
    }
  }
};

/**
 * Trigger a join for all closed groups which doesn't exist yet
 * @param openGroups string array of open group urls
 */
const handleClosedGroupsFromConfigLegacy = async (
  closedGroups: Array<SignalService.ConfigurationMessage.IClosedGroup>,
  envelope: EnvelopePlus
) => {
  if (window.sessionFeatureFlags.useSharedUtilForUserConfig && Registration.isDone()) {
    return;
  }
  const numberClosedGroup = closedGroups?.length || 0;

  window?.log?.info(
    `Received ${numberClosedGroup} closed group on configuration. Creating them... `
  );
  await Promise.all(
    closedGroups.map(async c => {
      const groupUpdate = new SignalService.DataMessage.ClosedGroupControlMessage({
        type: SignalService.DataMessage.ClosedGroupControlMessage.Type.NEW,
        encryptionKeyPair: c.encryptionKeyPair,
        name: c.name,
        admins: c.admins,
        members: c.members,
        publicKey: c.publicKey,
      });
      try {
        await handleNewClosedGroup(envelope, groupUpdate);
      } catch (e) {
        window?.log?.warn('failed to handle a new closed group from configuration message');
      }
    })
  );
};

/**
 * Handles adding of a contact and setting approval/block status
 * @param contactReceived Contact to sync
 */
const handleContactFromConfigLegacy = async (
  contactReceived: SignalService.ConfigurationMessage.IContact,
  envelope: EnvelopePlus
) => {
  if (window.sessionFeatureFlags.useSharedUtilForUserConfig && Registration.isDone()) {
    return;
  }
  try {
    if (!contactReceived.publicKey?.length) {
      return;
    }
    const contactConvo = await getConversationController().getOrCreateAndWait(
      toHex(contactReceived.publicKey),
      ConversationTypeEnum.PRIVATE
    );
    const profileInDataMessage: SignalService.DataMessage.ILokiProfile = {
      displayName: contactReceived.name,
      profilePicture: contactReceived.profilePicture,
    };

    const existingActiveAt = contactConvo.get('active_at');
    if (!existingActiveAt || existingActiveAt === 0) {
      contactConvo.set('active_at', toNumber(envelope.timestamp));
    }

    // checking for existence of field on protobuf
    if (contactReceived.isApproved === true) {
      if (!contactConvo.isApproved()) {
        await contactConvo.setIsApproved(Boolean(contactReceived.isApproved));
        await contactConvo.addOutgoingApprovalMessage(toNumber(envelope.timestamp));
      }

      if (contactReceived.didApproveMe === true) {
        // checking for existence of field on message
        await contactConvo.setDidApproveMe(Boolean(contactReceived.didApproveMe));
      }
    }

    // only set for explicit true/false values incase outdated sender doesn't have the fields
    if (contactReceived.isBlocked === true) {
      if (contactConvo.isIncomingRequest()) {
        // handling case where restored device's declined message requests were getting restored
        await ConversationInteraction.deleteAllMessagesByConvoIdNoConfirmation(contactConvo.id);
      }
      await BlockedNumberController.block(contactConvo.id);
    } else if (contactReceived.isBlocked === false) {
      await BlockedNumberController.unblockAll([contactConvo.id]);
    }

    await ProfileManager.updateProfileOfContact(
      contactConvo.id,
      profileInDataMessage.displayName || undefined,
      profileInDataMessage.profilePicture || null,
      contactReceived.profileKey || null
    );
  } catch (e) {
    window?.log?.warn('failed to handle  a new closed group from configuration message');
  }
};

/**
 * This is the legacy way of handling incoming configuration message.
 * Should not be used at all soon.
 */
async function handleConfigurationMessageLegacy(
  envelope: EnvelopePlus,
  configurationMessage: SignalService.ConfigurationMessage
): Promise<void> {
  // when the useSharedUtilForUserConfig flag is ON, we want only allow a legacy config message if we are registering a new user.
  // this is to allow users linking a device to find their config message if they do not have a shared config message yet.
  // the process of those messages is always done after the process of the shared config messages, so that's only a fallback.

  if (window.sessionFeatureFlags.useSharedUtilForUserConfig && Registration.isDone()) {
    window?.log?.info(
      'useSharedUtilForUserConfig is set, not handling config messages with "handleConfigurationMessageLegacy()"'
    );
    await removeFromCache(envelope);
    return;
  }

  window?.log?.info('Handling configuration message');
  const ourPubkey = UserUtils.getOurPubKeyStrFromCache();
  if (!ourPubkey) {
    return;
  }

  if (envelope.source !== ourPubkey) {
    window?.log?.info('Dropping configuration change from someone else than us.');
    return removeFromCache(envelope);
  }

  await handleOurProfileUpdateLegacy(envelope.timestamp, configurationMessage);

  await handleGroupsAndContactsFromConfigMessageLegacy(envelope, configurationMessage);

  await removeFromCache(envelope);
}

export const ConfigMessageHandler = {
  handleConfigurationMessageLegacy,
  handleConfigMessagesViaLibSession,
};
