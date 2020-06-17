import { Observable } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';

import ApiPromise from '@polkadot/api/promise';
import { Balance } from '@polkadot/types/interfaces';
import { GenericAccountId, Option, u32, u128, Vec } from '@polkadot/types';
import { Moment } from '@polkadot/types/interfaces/runtime';
import { QueueTxExtrinsicAdd } from '@polkadot/react-components/Status/types';
import { SubmittableExtrinsic } from '@polkadot/api/promise/types';
import keyringOption from '@polkadot/ui-keyring/options';

import { APIQueryCache, MultipleLinkedMapEntry, SingleLinkedMapEntry, Subscribable, Transport as TransportBase } from '@polkadot/joy-utils/index';

import { ITransport } from './transport';
import { GroupMember } from './elements';

import {
  Curator, CuratorId,
  CuratorApplication, CuratorApplicationId,
  CuratorInduction,
  CuratorRoleStakeProfile,
  CuratorOpening, CuratorOpeningId,
  Lead, LeadId
} from '@joystream/types/content-working-group';

import {
  WorkerApplication, WorkerApplicationId, WorkerOpening, WorkerOpeningId
} from '@joystream/types/bureaucracy';

import { Application, Opening } from '@joystream/types/hiring';
import { Stake, StakeId } from '@joystream/types/stake';
import { Recipient, RewardRelationship, RewardRelationshipId } from '@joystream/types/recurring-rewards';
import { ActorInRole, Profile, MemberId, Role, RoleKeys, ActorId } from '@joystream/types/members';
import { createAccount, generateSeed } from '@polkadot/joy-utils/accounts';

import { WorkingGroupMembership, StorageAndDistributionMembership, GroupLeadStatus } from './tabs/WorkingGroup';
import { WorkingGroupOpening } from './tabs/Opportunities';
import { ActiveRole, OpeningApplication } from './tabs/MyRoles';

import { keyPairDetails } from './flows/apply';

import {
  classifyApplicationCancellation,
  classifyOpeningStage,
  classifyOpeningStakes,
  isApplicationHired
} from './classifiers';
import { WorkingGroups, AvailableGroups } from './working_groups';
import { Sort, Sum, Zero } from './balances';

type WorkingGroupPair<HiringModuleType, WorkingGroupType> = {
  hiringModule: HiringModuleType;
  workingGroup: WorkingGroupType;
}

type StakePair<T = Balance> = {
  application: T;
  role: T;
}

interface IRoleAccounter {
  role_account: GenericAccountId;
  induction?: CuratorInduction;
  role_stake_profile?: Option<CuratorRoleStakeProfile>;
  reward_relationship: Option<RewardRelationshipId>;
}

type WGApiMethodType = 'nextOpeningId' | 'openingById' | 'nextApplicationId' | 'applicationById';
type WGApiMethodsMapping = { [key in WGApiMethodType]: string };
type WGToApiMethodsMapping = { [key in WorkingGroups]: { module: string; methods: WGApiMethodsMapping } };

type GroupApplication = CuratorApplication | WorkerApplication;
type GroupApplicationId = CuratorApplicationId | WorkerApplicationId;
type GroupOpening = CuratorOpening | WorkerOpening;
type GroupOpeningId = CuratorOpeningId | WorkerOpeningId;

const wgApiMethodsMapping: WGToApiMethodsMapping = {
  [WorkingGroups.StorageProviders]: {
    module: 'storageBureaucracy',
    methods: {
      nextOpeningId: 'nextWorkerOpeningId',
      openingById: 'workerOpeningById',
      nextApplicationId: 'nextWorkerApplicationId',
      applicationById: 'workerApplicationById'
    }
  },
  [WorkingGroups.ContentCurators]: {
    module: 'contentWorkingGroup',
    methods: {
      nextOpeningId: 'nextCuratorOpeningId',
      openingById: 'curatorOpeningById',
      nextApplicationId: 'nextCuratorApplicationId',
      applicationById: 'curatorApplicationById'
    }
  }
};

export class Transport extends TransportBase implements ITransport {
  protected api: ApiPromise
  protected cachedApi: APIQueryCache
  protected queueExtrinsic: QueueTxExtrinsicAdd

  constructor (api: ApiPromise, queueExtrinsic: QueueTxExtrinsicAdd) {
    super();
    this.api = api;
    this.cachedApi = new APIQueryCache(api);
    this.queueExtrinsic = queueExtrinsic;
  }

  cachedApiMethodByGroup (group: WorkingGroups, method: WGApiMethodType) {
    const apiModule = wgApiMethodsMapping[group].module;
    const apiMethod = wgApiMethodsMapping[group].methods[method];

    return this.cachedApi.query[apiModule][apiMethod];
  }

  unsubscribe () {
    this.cachedApi.unsubscribe();
  }

  async roles (): Promise<Array<Role>> {
    const roles: any = await this.cachedApi.query.actors.availableRoles();
    return this.promise<Array<Role>>(roles.map((role: Role) => role));
  }

  protected async stakeValue (stakeId: StakeId): Promise<Balance> {
    const stake = new SingleLinkedMapEntry<Stake>(
      Stake,
      await this.cachedApi.query.stake.stakes(
        stakeId
      )
    );
    return stake.value.value;
  }

  protected async curatorStake (stakeProfile: CuratorRoleStakeProfile): Promise<Balance> {
    return this.stakeValue(stakeProfile.stake_id);
  }

  protected async curatorTotalReward (relationshipId: RewardRelationshipId): Promise<Balance> {
    const relationship = new SingleLinkedMapEntry<RewardRelationship>(
      RewardRelationship,
      await this.cachedApi.query.recurringRewards.rewardRelationships(
        relationshipId
      )
    );
    const recipient = new SingleLinkedMapEntry<Recipient>(
      Recipient,
      await this.cachedApi.query.recurringRewards.rewardRelationships(
        relationship.value.recipient
      )
    );
    return recipient.value.total_reward_received;
  }

  protected async memberIdFromRoleAndActorId (role: Role, id: ActorId): Promise<MemberId> {
    const memberId = (
      await this.cachedApi.query.members.membershipIdByActorInRole(
        new ActorInRole({
          role: role,
          actor_id: id
        })
      )
    ) as MemberId;

    return memberId;
  }

  protected memberIdFromCuratorId (curatorId: CuratorId): Promise<MemberId> {
    return this.memberIdFromRoleAndActorId(
      new Role(RoleKeys.Curator),
      curatorId
    );
  }

  protected memberIdFromLeadId (leadId: LeadId): Promise<MemberId> {
    return this.memberIdFromRoleAndActorId(
      new Role(RoleKeys.CuratorLead),
      leadId
    );
  }

  protected async groupMember (id: CuratorId, curator: IRoleAccounter): Promise<GroupMember> {
    const roleAccount = curator.role_account;
    const memberId = await this.memberIdFromCuratorId(id);

    const profile = await this.cachedApi.query.members.memberProfile(memberId) as Option<Profile>;
    if (profile.isNone) {
      throw new Error('no profile found');
    }

    let stakeValue: Balance = new u128(0);
    if (curator.role_stake_profile && curator.role_stake_profile.isSome) {
      stakeValue = await this.curatorStake(curator.role_stake_profile.unwrap());
    }

    let earnedValue: Balance = new u128(0);
    if (curator.reward_relationship && curator.reward_relationship.isSome) {
      earnedValue = await this.curatorTotalReward(curator.reward_relationship.unwrap());
    }

    return ({
      roleAccount,
      memberId,
      profile: profile.unwrap(),
      title: 'Content curator',
      stake: stakeValue,
      earned: earnedValue
    });
  }

  protected async areAnyCuratorRolesOpen (): Promise<boolean> {
    const nextId = await this.cachedApi.query.contentWorkingGroup.nextCuratorOpeningId() as CuratorId;

    // This is chain specfic, but if next id is still 0, it means no openings have been added yet
    if (nextId.eq(0)) {
      return false;
    }

    const curatorOpenings = new MultipleLinkedMapEntry<CuratorOpeningId, CuratorOpening>(
      CuratorOpeningId,
      CuratorOpening,
      await this.cachedApi.query.contentWorkingGroup.curatorOpeningById()
    );

    for (let i = 0; i < curatorOpenings.linked_values.length; i++) {
      const opening = await this.opening(curatorOpenings.linked_values[i].opening_id.toNumber());
      if (opening.is_active) {
        return true;
      }
    }

    return false;
  }

  async groupLeadStatus (): Promise<GroupLeadStatus> {
    const optLeadId = (await this.cachedApi.query.contentWorkingGroup.currentLeadId()) as Option<LeadId>;

    if (optLeadId.isSome) {
      const leadId = optLeadId.unwrap();
      const lead = new SingleLinkedMapEntry<Lead>(
        Lead,
        await this.cachedApi.query.contentWorkingGroup.leadById(leadId)
      );

      const memberId = await this.memberIdFromLeadId(leadId);

      const profile = await this.cachedApi.query.members.memberProfile(memberId) as Option<Profile>;
      if (profile.isNone) {
        throw new Error('no profile found');
      }

      return {
        lead: {
          memberId,
          roleAccount: lead.value.role_account,
          profile: profile.unwrap(),
          title: 'Content Lead',
          stage: lead.value.stage
        },
        loaded: true
      };
    } else {
      return {
        loaded: true
      };
    }
  }

  async curationGroup (): Promise<WorkingGroupMembership> {
    const rolesAvailable = await this.areAnyCuratorRolesOpen();

    const nextId = await this.cachedApi.query.contentWorkingGroup.nextCuratorId() as CuratorId;

    // This is chain specfic, but if next id is still 0, it means no curators have been added yet
    if (nextId.eq(0)) {
      return {
        members: [],
        rolesAvailable
      };
    }

    const values = new MultipleLinkedMapEntry<CuratorId, Curator>(
      CuratorId,
      Curator,
      await this.cachedApi.query.contentWorkingGroup.curatorById()
    );

    const members = values.linked_values.filter(value => value.is_active).reverse();
    const memberIds = values.linked_keys.filter((v, k) => values.linked_values[k].is_active).reverse();

    return {
      members: await Promise.all(
        members.map((member, k) => this.groupMember(memberIds[k], member))
      ),
      rolesAvailable
    };
  }

  storageGroup (): Promise<StorageAndDistributionMembership> {
    return this.promise<StorageAndDistributionMembership>(
      {} as StorageAndDistributionMembership
    );
  }

  async opportunitiesByGroup (group: WorkingGroups): Promise<WorkingGroupOpening[]> {
    const output = new Array<WorkingGroupOpening>();
    const nextId = (await this.cachedApiMethodByGroup(group, 'nextOpeningId')()) as GroupOpeningId;

    // This is chain specfic, but if next id is still 0, it means no curator openings have been added yet
    if (!nextId.eq(0)) {
      const highestId = nextId.toNumber() - 1;

      for (let i = highestId; i >= 0; i--) {
        output.push(await this.groupOpening(group, i));
      }
    }

    return output;
  }

  async currentOpportunities (): Promise<WorkingGroupOpening[]> {
    let opportunities: WorkingGroupOpening[] = [];

    for (const group of AvailableGroups) {
      opportunities = opportunities.concat(await this.opportunitiesByGroup(group));
    }

    return opportunities.sort((a, b) => b.stage.starting_block - a.stage.starting_block);
  }

  protected async opening (id: number): Promise<Opening> {
    const opening = new SingleLinkedMapEntry<Opening>(
      Opening,
      await this.cachedApi.query.hiring.openingById(id)
    );

    return opening.value;
  }

  protected async groupOpeningApplications (group: WorkingGroups, groupOpeningId: number): Promise<WorkingGroupPair<Application, GroupApplication>[]> {
    const output = new Array<WorkingGroupPair<Application, GroupApplication>>();

    const nextAppid = (await this.cachedApiMethodByGroup(group, 'nextApplicationId')()) as GroupApplicationId;
    for (let i = 0; i < nextAppid.toNumber(); i++) {
      const cApplication = new SingleLinkedMapEntry<GroupApplication>(
        group === WorkingGroups.ContentCurators ? CuratorApplication : WorkerApplication,
        await this.cachedApiMethodByGroup(group, 'applicationById')(i)
      );

      if (cApplication.value.worker_opening_id.toNumber() !== groupOpeningId) {
        continue;
      }

      const appId = cApplication.value.application_id;
      const baseApplications = new SingleLinkedMapEntry<Application>(
        Application,
        await this.cachedApi.query.hiring.applicationById(
          appId
        )
      );

      output.push({
        hiringModule: baseApplications.value,
        workingGroup: cApplication.value
      });
    }

    return output;
  }

  protected async curatorOpeningApplications (curatorOpeningId: number): Promise<WorkingGroupPair<Application, CuratorApplication>[]> {
    // Backwards compatibility
    const applications = await this.groupOpeningApplications(WorkingGroups.ContentCurators, curatorOpeningId);
    return applications as WorkingGroupPair<Application, CuratorApplication>[];
  }

  async groupOpening (group: WorkingGroups, id: number): Promise<WorkingGroupOpening> {
    const nextId = (await this.cachedApiMethodByGroup(group, 'nextOpeningId')() as u32).toNumber();
    if (id < 0 || id >= nextId) {
      throw new Error('invalid id');
    }

    const groupOpening = new SingleLinkedMapEntry<GroupOpening>(
      group === WorkingGroups.ContentCurators ? CuratorOpening : WorkerOpening,
      await this.cachedApiMethodByGroup(group, 'openingById')(id)
    );

    const opening = await this.opening(
      groupOpening.value.opening_id.toNumber()
    );

    const applications = await this.groupOpeningApplications(group, id);
    const stakes = classifyOpeningStakes(opening);

    return ({
      opening: opening,
      meta: {
        id: id.toString(),
        group
      },
      stage: await classifyOpeningStage(this, opening),
      applications: {
        numberOfApplications: applications.length,
        maxNumberOfApplications: opening.max_applicants,
        requiredApplicationStake: stakes.application,
        requiredRoleStake: stakes.role,
        defactoMinimumStake: new u128(0)
      },
      defactoMinimumStake: new u128(0)
    });
  }

  async curationGroupOpening (id: number): Promise<WorkingGroupOpening> {
    // Backwards compatibility
    return this.groupOpening(WorkingGroups.ContentCurators, id);
  }

  protected async openingApplicationTotalStake (application: Application): Promise<Balance> {
    const promises = new Array<Promise<Balance>>();

    if (application.active_application_staking_id.isSome) {
      promises.push(this.stakeValue(application.active_application_staking_id.unwrap()));
    }

    if (application.active_role_staking_id.isSome) {
      promises.push(this.stakeValue(application.active_role_staking_id.unwrap()));
    }

    return Sum(await Promise.all(promises));
  }

  async openingApplicationRanks (openingId: number): Promise<Balance[]> {
    const applications = await this.curatorOpeningApplications(openingId);
    return Sort(
      (await Promise.all(
        applications.map(application => this.openingApplicationTotalStake(application.hiringModule))
      ))
        .filter((b) => !b.eq(Zero))
    );
  }

  expectedBlockTime (): Promise<number> {
    return this.promise<number>(
      (this.api.consts.babe.expectedBlockTime as Moment).toNumber() / 1000
    );
  }

  async blockHash (height: number): Promise<string> {
    const blockHash = await this.cachedApi.query.system.blockHash(height);
    return blockHash.toString();
  }

  async blockTimestamp (height: number): Promise<Date> {
    const blockTime = await this.api.query.timestamp.now.at(
      await this.blockHash(height)
    ) as Moment;

    return new Date(blockTime.toNumber());
  }

  transactionFee (): Promise<Balance> {
    return this.promise<Balance>(new u128(5));
  }

  accounts (): Subscribable<keyPairDetails[]> {
    return keyringOption.optionsSubject.pipe(
      map(accounts => {
        return accounts.all
          .filter(x => x.value)
          .map(async (result, k) => {
            return {
              shortName: result.name,
              accountId: new GenericAccountId(result.value as string),
              balance: await this.cachedApi.query.balances.freeBalance(result.value as string)
            };
          });
      }),
      switchMap(async x => Promise.all(x))
    ) as Subscribable<keyPairDetails[]>;
  }

  protected async applicationStakes (app: Application): Promise<StakePair<Balance>> {
    const stakes = {
      application: Zero,
      role: Zero
    };

    const appStake = app.active_application_staking_id;
    if (appStake.isSome) {
      stakes.application = await this.stakeValue(appStake.unwrap());
    }

    const roleStake = app.active_role_staking_id;
    if (roleStake.isSome) {
      stakes.role = await this.stakeValue(roleStake.unwrap());
    }

    return stakes;
  }

  protected async myApplicationRank (myApp: Application, applications: Array<Application>): Promise<number> {
    const stakes = await Promise.all(
      applications.map(app => this.openingApplicationTotalStake(app))
    );

    const appvalues = applications.map((app, key) => {
      return {
        app: app,
        value: stakes[key]
      };
    });

    appvalues.sort((a, b): number => {
      if (a.value.eq(b.value)) {
        return 0;
      } else if (a.value.gt(b.value)) {
        return -1;
      }

      return 1;
    });

    return appvalues.findIndex(v => v.app.eq(myApp)) + 1;
  }

  async openingApplications (roleKeyId: string): Promise<OpeningApplication[]> {
    const curatorApps = new MultipleLinkedMapEntry<CuratorApplicationId, CuratorApplication>(
      CuratorApplicationId,
      CuratorApplication,
      await this.cachedApi.query.contentWorkingGroup.curatorApplicationById()
    );

    const myApps = curatorApps.linked_values.filter(app => app.role_account.eq(roleKeyId));
    const myAppIds = curatorApps.linked_keys.filter((id, key) => curatorApps.linked_values[key].role_account.eq(roleKeyId));

    const hiringAppPairs = await Promise.all(
      myApps.map(
        async app => new SingleLinkedMapEntry<Application>(
          Application,
          await this.cachedApi.query.hiring.applicationById(
            app.application_id
          )
        )
      )
    );

    const hiringApps = hiringAppPairs.map(app => app.value);

    const stakes = await Promise.all(
      hiringApps.map(app => this.applicationStakes(app))
    );

    const wgs = await Promise.all(
      myApps.map(curatorOpening => {
        return this.curationGroupOpening(curatorOpening.curator_opening_id.toNumber());
      })
    );

    const allAppsByOpening = (await Promise.all(
      myApps.map(curatorOpening => {
        return this.curatorOpeningApplications(curatorOpening.curator_opening_id.toNumber());
      })
    ));

    return await Promise.all(
      wgs.map(async (wg, key) => {
        return {
          id: myAppIds[key].toNumber(),
          hired: isApplicationHired(hiringApps[key]),
          cancelledReason: classifyApplicationCancellation(hiringApps[key]),
          rank: await this.myApplicationRank(hiringApps[key], allAppsByOpening[key].map(a => a.hiringModule)),
          capacity: wg.applications.maxNumberOfApplications,
          stage: wg.stage,
          opening: wg.opening,
          meta: wg.meta,
          applicationStake: stakes[key].application,
          roleStake: stakes[key].role,
          review_end_time: wg.stage.review_end_time,
          review_end_block: wg.stage.review_end_block
        };
      })
    );
  }

  async myCurationGroupRoles (roleKeyId: string): Promise<ActiveRole[]> {
    const curators = new MultipleLinkedMapEntry<CuratorId, Curator>(
      CuratorId,
      Curator,
      await this.cachedApi.query.contentWorkingGroup.curatorById()
    );

    return Promise.all(
      curators
        .linked_values
        .toArray()
        .filter(curator => curator.role_account.eq(roleKeyId) && curator.is_active)
        .map(async (curator, key) => {
          let stakeValue: Balance = new u128(0);
          if (curator.role_stake_profile && curator.role_stake_profile.isSome) {
            stakeValue = await this.curatorStake(curator.role_stake_profile.unwrap());
          }

          let earnedValue: Balance = new u128(0);
          if (curator.reward_relationship && curator.reward_relationship.isSome) {
            earnedValue = await this.curatorTotalReward(curator.reward_relationship.unwrap());
          }

          return {
            curatorId: curators.linked_keys[key],
            name: 'Content curator',
            reward: earnedValue,
            stake: stakeValue
          };
        })
    );
  }

  myStorageGroupRoles (): Subscribable<ActiveRole[]> {
    return new Observable<ActiveRole[]>(observer => { /* do nothing */ });
  }

  protected generateRoleAccount (name: string, password = ''): string | null {
    const { address, deriveError, derivePath, isSeedValid, pairType, seed } = generateSeed(null, '', 'bip');

    const isValid = !!address && !deriveError && isSeedValid;
    if (!isValid) {
      return null;
    }

    const status = createAccount(`${seed}${derivePath}`, pairType, name, password, 'created account');
    return status.account as string;
  }

  applyToCuratorOpening (
    id: number,
    roleAccountName: string,
    sourceAccount: string,
    appStake: Balance,
    roleStake: Balance,
    applicationText: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      (this.cachedApi.query.members.memberIdsByControllerAccountId(sourceAccount) as Promise<Vec<MemberId>>)
        .then(membershipIds => {
          if (membershipIds.length === 0) {
            reject(new Error('No membship ID associated with this address'));
          }

          const roleAccount = this.generateRoleAccount(roleAccountName);
          if (!roleAccount) {
            reject(new Error('failed to create role account'));
          }
          const tx = this.api.tx.contentWorkingGroup.applyOnCuratorOpening(
            membershipIds[0],
            new u32(id),
            new GenericAccountId(roleAccount as string),
            roleStake.eq(Zero) ? null : roleStake,
            appStake.eq(Zero) ? null : appStake,
            applicationText
          ) as unknown as SubmittableExtrinsic;

          const txFailedCb = () => {
            reject(new Error('transaction failed'));
          };

          const txSuccessCb = () => {
            resolve(1);
          };

          this.queueExtrinsic({
            accountId: sourceAccount,
            extrinsic: tx,
            txFailedCb,
            txSuccessCb
          });
        });
    });
  }

  leaveCurationRole (sourceAccount: string, id: number, rationale: string) {
    const tx = this.api.tx.contentWorkingGroup.leaveCuratorRole(
      id,
      rationale
    ) as unknown as SubmittableExtrinsic;

    this.queueExtrinsic({
      accountId: sourceAccount,
      extrinsic: tx
    });
  }

  withdrawCuratorApplication (sourceAccount: string, id: number) {
    const tx = this.api.tx.contentWorkingGroup.withdrawCuratorApplication(
      id
    ) as unknown as SubmittableExtrinsic;

    this.queueExtrinsic({
      accountId: sourceAccount,
      extrinsic: tx
    });
  }
}