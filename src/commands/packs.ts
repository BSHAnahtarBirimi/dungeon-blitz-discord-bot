import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	CommandBuilder,
	CommandContext,
	ContainerBuilder,
	GalleryBuilder,
	GalleryItemBuilder,
	IntegrationType,
	InteractionFlags,
	SectionBuilder,
	SeparatorBuilder,
	SeparatorSpacingSize,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextDisplayBuilder,
} from "@minesa-org/mini-interaction";
import { MessageFlags } from "discord-api-types/v10";
import type { MessageActionRowComponent } from "@minesa-org/mini-interaction";
import type {
	CommandInteraction,
	MessageComponentInteraction,
} from "@minesa-org/mini-interaction";
import {
	SPONSOR_PACKS,
	formatUsd,
	purchaseSponsorPack,
	findSponsorPack,
	type SponsorCredit,
	type SponsorPack,
} from "../utils/sponsorPacks.js";
import { getMemberRoleIds, interactionDiscordId } from "../utils/discordInteractions.js";

const BUY_BUTTON_PREFIX = "packs:buy:";
const PACK_SELECT_ID = "packs:view";

// Components V2 messages require the IsComponentsV2 flag; shop views are ephemeral.
const CONTAINER_FLAGS = MessageFlags.IsComponentsV2;
const CONTAINER_EPHEMERAL_FLAGS =
	(MessageFlags.IsComponentsV2 | InteractionFlags.Ephemeral) as MessageFlags;

function packPriceLabel(pack: SponsorPack) {
	return pack.priceCents === 0 ? "FREE" : formatUsd(pack.priceCents);
}

function packButtonLabel(pack: SponsorPack) {
	return pack.priceCents === 0 ? "Claim" : "Buy";
}

function buildPackSelectRow(defaultId?: string) {
	const select = new StringSelectMenuBuilder()
		.setCustomId(PACK_SELECT_ID)
		.setPlaceholder("Select a pack to view…")
		.setMinValues(1)
		.setMaxValues(1)
		.setOptions(
			SPONSOR_PACKS.map((pack) =>
				new StringSelectMenuOptionBuilder()
					.setLabel(`${pack.name} — ${packPriceLabel(pack)}`)
					.setValue(pack.id)
					.setEmoji(pack.emoji)
					.setDescription(
						pack.requiredRoleId
							? "Sponsor role required"
							: undefined,
					)
					.setDefault(pack.id === defaultId),
			),
		);

	return new ActionRowBuilder<MessageActionRowComponent>().addComponents(select);
}

function buildPackContainer(
	pack: SponsorPack,
	credit?: SponsorCredit | null,
): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(pack.color);

	// Pack image gallery
	const gallery = new GalleryBuilder().addItem(
		new GalleryItemBuilder().setMedia({ url: pack.imageUrl }).setDescription(pack.name),
	);
	container.addComponent(gallery);

	// Header + price + role info
	const headerParts: string[] = [];
	headerParts.push(`### ${pack.emoji} ${pack.name}`);
	headerParts.push(`**Price:** ${packPriceLabel(pack)}`);

	if (pack.requiredRoleId) {
		headerParts.push(`-# 🎟️ Free claim for <@&${pack.requiredRoleId}> role holders only`);
	}

	if (credit) {
		headerParts.push(
			`-# 💰 Your balance: ${credit.balanceCents === null ? "Unknown" : formatUsd(credit.balanceCents)}`,
		);
	}

	container.addComponent(
		new TextDisplayBuilder().setContent(headerParts.join("\n")),
	);

	container.addComponent(
		new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);

	// Buy/Claim button in a section
	container.addSection(
		new SectionBuilder()
			.addComponent(
				new TextDisplayBuilder().setContent(
					pack.priceCents === 0
						? "-# Tap **Claim** to get this free pack"
						: `-# Tap **Buy** to purchase with ${formatUsd(pack.priceCents)}`,
				),
			)
			.setAccessory(
				new ButtonBuilder()
					.setLabel(packButtonLabel(pack))
					.setStyle(ButtonStyle.Primary)
					.setCustomId(`${BUY_BUTTON_PREFIX}${pack.id}`),
			),
	);

	container.addComponent(
		new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);

	// Select menu row at the bottom
	container.addComponent(buildPackSelectRow(pack.id));

	return container;
}

function buildShopContainer(): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(0xf1c40f);

	container.addComponent(
		new TextDisplayBuilder().setContent(
			"## 🛍️ Sponsor Pack Shop\nBrowse and purchase sponsor packs below.\n-# Select a pack to see details and purchase.",
		),
	);

	container.addComponent(
		new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);

	container.addComponent(buildPackSelectRow());

	return container;
}

function buildPurchasedContainer(
	pack: SponsorPack,
	credit: SponsorCredit,
): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(pack.color);

	// Pack image
	const gallery = new GalleryBuilder().addItem(
		new GalleryItemBuilder().setMedia({ url: pack.imageUrl }).setDescription(pack.name),
	);
	container.addComponent(gallery);

	container.addComponent(
		new TextDisplayBuilder().setContent(
			`### ${pack.emoji} ${pack.name} purchased!${pack.priceCents === 0 ? " (free claim)" : ""}`,
		),
	);

	container.addComponent(
		new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);

	container.addComponent(
		new TextDisplayBuilder().setContent(
			[
				`**Price:** ${packPriceLabel(pack)}`,
				`**Remaining balance:** ${credit.balanceCents === null ? "Unknown" : formatUsd(credit.balanceCents)}`,
				`**Sponsored / Used:** ${credit.sponsoredCents === null ? "Unknown" : formatUsd(credit.sponsoredCents)} / ${formatUsd(credit.usedCents)}`,
			].join("\n"),
		),
	);

	container.addComponent(
		new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);

	container.addComponent(
		new TextDisplayBuilder().setContent(
			"-# Pack contents are delivered to your game account by the team.",
		),
	);

	// Select menu to keep browsing
	container.addComponent(buildPackSelectRow());

	return container;
}

async function respondWithPurchase(
	discordId: string,
	packId: string,
	memberRoleIds: string[],
	editReply: (data: Record<string, unknown>) => Promise<unknown>,
) {
	const result = await purchaseSponsorPack(discordId, packId, memberRoleIds);
	switch (result.status) {
		case "no-profile":
			return editReply({
				content:
					"Your Discord account has no linked GitHub account, so donation credit cannot be checked. Link GitHub through the account linking flow first.",
				flags: InteractionFlags.Ephemeral,
			});
		case "missing-role":
			return editReply({
				content: `The **${result.pack.name}** is a free claim for sponsors only — you need the <@&${result.pack.requiredRoleId}> role to claim it.`,
				flags: InteractionFlags.Ephemeral,
			});
		case "already-claimed":
			return editReply({
				content: `You already claimed the **${result.pack.name}**. Each player can claim it once.`,
				flags: InteractionFlags.Ephemeral,
			});
		case "not-sponsor":
			return editReply({
				content:
					"Only GitHub sponsors have donation credit to spend. Sponsor The Minesa Studios on GitHub Sponsors first!",
				flags: InteractionFlags.Ephemeral,
			});
		case "credit-unknown":
			return editReply({
				content:
					"Your donation total could not be verified with GitHub right now. Please try again later.",
				flags: InteractionFlags.Ephemeral,
			});
		case "insufficient":
			return editReply({
				content: `You need ${formatUsd(result.pack.priceCents)} of donation credit for the **${result.pack.name}**, but your remaining balance is ${formatUsd(result.balanceCents)}.`,
				flags: InteractionFlags.Ephemeral,
			});
		case "conflict":
			return editReply({
				content:
					"Your balance changed while processing the purchase. Please try again.",
				flags: InteractionFlags.Ephemeral,
			});
	}

	const { pack, credit } = result;
	return editReply({
		components: [buildPurchasedContainer(pack, credit)],
		flags: CONTAINER_EPHEMERAL_FLAGS,
	});
}

async function handleBuy(
	interaction: CommandInteraction | MessageComponentInteraction,
	packId: string,
) {
	const discordId = interactionDiscordId(interaction);
	if (!discordId) {
		return interaction.reply({
			content: "Your Discord account could not be verified.",
			flags: InteractionFlags.Ephemeral,
		});
	}

	await interaction.deferReply({ flags: InteractionFlags.Ephemeral });
	try {
		return await respondWithPurchase(
			discordId,
			packId,
			getMemberRoleIds(interaction),
			(data) => interaction.editReply(data as never),
		);
	} catch (error) {
		console.error("[packs] Purchase failed:", error);
		return interaction.editReply({
			content:
				"The purchase could not be processed right now. Please try again later.",
		});
	}
}

async function handlePackView(
	interaction: MessageComponentInteraction,
) {
	const packId = interaction.getStringValues()[0];
	const pack = packId ? findSponsorPack(packId) : null;

	if (!pack) {
		return interaction.reply({
			content: "Invalid pack selection.",
			flags: InteractionFlags.Ephemeral,
		});
	}

	return interaction.update({
		components: [buildPackContainer(pack)],
		flags: CONTAINER_FLAGS,
	});
}

async function handleShop(
	interaction: CommandInteraction | MessageComponentInteraction,
) {
	return interaction.reply({
		components: [buildShopContainer()],
		flags: CONTAINER_EPHEMERAL_FLAGS,
	});
}

export const packsCommand = {
	data: new CommandBuilder()
		.setContexts([CommandContext.Guild])
		.setIntegrationTypes([IntegrationType.GuildInstall])
		.setName("packs")
		.setDescription("Browse and buy sponsor packs")
		.setDMPermission(false),
	handler: (interaction: CommandInteraction) => handleShop(interaction),
};

export const packsBuyComponent = {
	customId: BUY_BUTTON_PREFIX,
	handler: (interaction: MessageComponentInteraction) => {
		if (!interaction.data.custom_id.startsWith(BUY_BUTTON_PREFIX)) {
			return interaction.reply({
				content: "That pack button is no longer valid.",
				flags: InteractionFlags.Ephemeral,
			});
		}
		return handleBuy(
			interaction,
			interaction.data.custom_id.slice(BUY_BUTTON_PREFIX.length),
		);
	},
};

export const packsSelectComponent = {
	customId: PACK_SELECT_ID,
	handler: (interaction: MessageComponentInteraction) =>
		handlePackView(interaction),
};
