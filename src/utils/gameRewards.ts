import { MongoClient, type Collection, type Filter } from "mongodb";
import type { PackReward, PackRewardDeliveryResult } from "./sponsorPacks.js";
import { CONSUMABLE_ID_BY_KIND } from "./sponsorPacks.js";

type RewardDocument = Document & {
	_id: string;
	user_id?: number;
	characters?: Document[];
	updatedAt?: Date;
};

type AccountDocument = Document & {
	_id: string;
	user_id?: number;
	discordId?: string;
};

export type GameSaveCharacterRef = {
	userId: number;
	characterName: string;
};

/** Character option surfaced in the shop's delivery-target picker. */
export type GameCharacterOption = {
	name: string;
	level: number;
	class: string;
};

/**
 * Resolves the Dungeon Blitz user ID linked to a Discord account, or null.
 */
export async function findGameUserIdForDiscord(discordId: string): Promise<number | null> {
	const normalized = String(discordId ?? "").trim();
	if (!normalized) return null;

	const accounts = await getAccountsCollection();
	const account = await accounts
		.findOne({ discordId: normalized } as Filter<AccountDocument>, { projection: { user_id: 1 } })
		.catch(() => null);
	const userId = normalizeAmount(account?.user_id);
	return userId > 0 ? userId : null;
}

/**
 * Lists the characters on the buyer's game save so the shop can offer a
 * delivery-target picker. Falls back to an empty list when nothing is linked.
 */
export async function listGameSaveCharacters(
	discordId: string,
): Promise<GameCharacterOption[]> {
	const normalized = String(discordId ?? "").trim();
	if (!normalized) return [];

	const accounts = await getAccountsCollection();
	const account = await accounts
		.findOne({ discordId: normalized } as Filter<AccountDocument>, { projection: { user_id: 1 } })
		.catch(() => null);
	const userId = normalizeAmount(account?.user_id);
	if (!userId) return [];

	const saves = await getSavesCollection();
	const save = await saves
		.findOne({ user_id: userId } as Filter<RewardDocument>, { sort: { updatedAt: -1 } })
		.catch(() => null);
	const characters = Array.isArray(save?.characters) ? save!.characters! : [];
	return characters
		.map((character) => {
			const record = character as { name?: unknown; level?: unknown; class?: unknown } | null;
			const name = String(record?.name ?? "").trim();
			if (!name) return null;
			return {
				name,
				level: normalizeAmount(record?.level),
				class: String(record?.class ?? "").trim(),
			};
		})
		.filter((character): character is GameCharacterOption => character !== null);
}

let clientPromise: Promise<MongoClient> | null = null;

function normalizeAmount(value: unknown): number {
	const amount = Number(value ?? 0);
	return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
}

function getMongoUri(): string {
	const uri = process.env.GAME_MONGODB_URI?.trim() || process.env.MONGODB_URI?.trim();
	if (!uri) throw new Error("GAME_MONGODB_URI or MONGODB_URI is required");
	return uri;
}

async function getClient(): Promise<MongoClient> {
	if (clientPromise) return clientPromise;
	clientPromise = (async () => {
		const client = new MongoClient(getMongoUri(), { ignoreUndefined: true });
		await client.connect();
		return client;
	})().catch((error) => {
		clientPromise = null;
		throw error;
	});
	return clientPromise;
}

async function getAccountsCollection(): Promise<Collection<AccountDocument>> {
	const client = await getClient();
	return client
		.db(
			process.env.GAME_MONGODB_DB_NAME?.trim() ||
				process.env.MONGODB_DB_NAME?.trim() ||
				"minidb",
		)
		.collection<AccountDocument>(
			process.env.MONGODB_ACCOUNTS_COLLECTION?.trim() || "accounts",
		);
}

async function getSavesCollection(): Promise<Collection<RewardDocument>> {
	const client = await getClient();
	return client
		.db(
			process.env.GAME_MONGODB_DB_NAME?.trim() ||
				process.env.MONGODB_DB_NAME?.trim() ||
				"minidb",
		)
		.collection<RewardDocument>(
			process.env.MONGODB_SAVES_COLLECTION?.trim() || "saves",
		);
}

/**
 * Picks the buyer's game character: the save linked to their Dungeon Blitz
 * account (matched through the accounts collection by Discord ID), preferring
 * the most recently updated character when the account owns several.
 */
export async function findDefaultGameSaveCharacter(
	discordId: string,
): Promise<GameSaveCharacterRef | null> {
	const normalized = String(discordId ?? "").trim();
	if (!normalized) return null;

	const accounts = await getAccountsCollection();
	const account = await accounts
		.findOne({ discordId: normalized } as Filter<AccountDocument>, { projection: { user_id: 1 } })
		.catch(() => null);
	const userId = normalizeAmount(account?.user_id);
	if (!userId) return null;

	const saves = await getSavesCollection();
	const save = await saves
		.findOne(
			{ user_id: userId, "characters.name": { $exists: true, $ne: "" } } as Filter<RewardDocument>,
			{ sort: { updatedAt: -1 } },
		)
		.catch(() => null);
	const characters = Array.isArray(save?.characters) ? save!.characters! : [];
	const named = characters
		.map((character) => String((character as { name?: unknown } | null)?.name ?? "").trim())
		.find(Boolean);
	if (!named) return null;
	return { userId, characterName: named };
}

/** Formats one reward into a short "what you got" line for the shop confirmation. */
export function formatRewardLine(reward: PackReward): string {
	switch (reward.kind) {
		case "mount":
			return `Mount #${reward.mountId}${reward.exclusive ? " (exclusive)" : ""}`;
		case "dye":
			return `Legendary dye #${reward.dyeId}`;
		case "lockbox":
			return `${reward.count.toLocaleString()}× Trove Chest`;
		case "consumable":
			return `${reward.count}× ${reward.consumableId} potion`;
		case "gold":
			return `${reward.amount.toLocaleString()} gold`;
		case "sigils":
			return `${reward.amount.toLocaleString()} Silver Sigils`;
	}
}

/**
 * Writes every reward into the target character's save document using atomic
 * per-field updates (arrayFilters target the exact character), so a concurrent
 * game-server save can never clobber an unrelated field.
 */
export async function applyPackRewardsToSave(
	userId: number,
	characterName: string,
	rewards: PackReward[],
): Promise<PackRewardDeliveryResult[]> {
	const saves = await getSavesCollection();
	const results: PackRewardDeliveryResult[] = [];

	for (const reward of rewards) {
		try {
			results.push(await applySingleReward(saves, userId, characterName, reward));
		} catch (error) {
			results.push({
				status: "failed",
				delivery: { reward, characterName },
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}

function fail(reward: PackReward, characterName: string, error: string): PackRewardDeliveryResult {
	return { status: "failed", delivery: { reward, characterName }, error };
}

async function applySingleReward(
	saves: Collection<RewardDocument>,
	userId: number,
	characterName: string,
	reward: PackReward,
): Promise<PackRewardDeliveryResult> {
	const arrayFilters = [{ "char.name": characterName }];
	const touch = { updatedAt: new Date() };

	switch (reward.kind) {
		case "mount": {
			// $addToSet keeps the mount list duplicate-free even if the game client
			// already granted the same mount.
			const result = await saves.updateOne(
				{ user_id: userId, "characters.name": characterName } as Filter<RewardDocument>,
				{
					$addToSet: { "characters.$[char].mounts": reward.mountId },
					$set: touch,
				} as never,
				{ arrayFilters } as never,
			);
			if (result.matchedCount === 0) {
				return fail(reward, characterName, "Character not found in the game save.");
			}
			break;
		}
		case "dye": {
			const result = await saves.updateOne(
				{ user_id: userId, "characters.name": characterName } as Filter<RewardDocument>,
				{
					$addToSet: { "characters.$[char].OwnedDyes": reward.dyeId },
					$set: touch,
				} as never,
				{ arrayFilters } as never,
			);
			if (result.matchedCount === 0) {
				return fail(reward, characterName, "Character not found in the game save.");
			}
			break;
		}
		case "lockbox": {
			const delivered = await bumpStackedEntry(
				saves,
				userId,
				characterName,
				"lockboxes",
				"lockboxID",
				reward.lockboxId,
				reward.count,
				arrayFilters,
			);
			if (!delivered) {
				return fail(reward, characterName, "Character not found in the game save.");
			}
			break;
		}
		case "consumable": {
			const consumableId = CONSUMABLE_ID_BY_KIND[reward.consumableId];
			const delivered = await bumpStackedEntry(
				saves,
				userId,
				characterName,
				"consumables",
				"consumableID",
				consumableId,
				reward.count,
				arrayFilters,
			);
			if (!delivered) {
				return fail(reward, characterName, "Character not found in the game save.");
			}
			break;
		}
		case "gold": {
			const result = await saves.updateOne(
				{ user_id: userId, "characters.name": characterName } as Filter<RewardDocument>,
				{ $inc: { "characters.$[char].gold": reward.amount }, $set: touch } as never,
				{ arrayFilters } as never,
			);
			if (result.matchedCount === 0) {
				return fail(reward, characterName, "Character not found in the game save.");
			}
			break;
		}
		case "sigils": {
			const result = await saves.updateOne(
				{ user_id: userId, "characters.name": characterName } as Filter<RewardDocument>,
				{
					$inc: { "characters.$[char].SilverSigils": reward.amount },
					$set: touch,
				} as never,
				{ arrayFilters } as never,
			);
			if (result.matchedCount === 0) {
				return fail(reward, characterName, "Character not found in the game save.");
			}
			break;
		}
	}

	return { status: "delivered", delivery: { reward, characterName } };
}

/**
 * Adds `count` to a stacked array entry such as lockboxes/consumables. Tries an
 * atomic $inc on the matching entry first; when the character does not own that
 * stack yet (modifiedCount 0 despite a match), falls back to $push.
 */
async function bumpStackedEntry(
	saves: Collection<RewardDocument>,
	userId: number,
	characterName: string,
	field: "lockboxes" | "consumables",
	idField: "lockboxID" | "consumableID",
	entryId: number,
	count: number,
	arrayFilters: Record<string, unknown>[],
): Promise<boolean> {
	const saveFilter = { user_id: userId, "characters.name": characterName } as Filter<RewardDocument>;
	const increment = await saves.updateOne(
		saveFilter,
		{
			$inc: { [`characters.$[char].${field}.$[entry].count`]: count },
			$set: { updatedAt: new Date() },
		} as never,
		{
			arrayFilters: [...arrayFilters, { [`entry.${idField}`]: entryId }],
		} as never,
	);
	if (increment.matchedCount === 0) return false;
	if (increment.modifiedCount > 0) return true;

	// The character exists but does not own this stack yet — create it.
	const push = await saves.updateOne(
		saveFilter,
		{
			$push: { [`characters.$[char].${field}`]: { [idField]: entryId, count } },
			$set: { updatedAt: new Date() },
		} as never,
		{ arrayFilters } as never,
	);
	return push.matchedCount > 0;
}
