import { CommandBuilder } from "@minesa-org/mini-interaction";
import type { AutocompleteContext } from "@minesa-org/mini-interaction";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { getPlayerProfile, searchPlayers } from "../utils/gameWallet.js";
import { addCreditsToPlayer } from "../utils/sponsorPacks.js";
import { interactionDiscordId, isAdministrator } from "../utils/discordInteractions.js";

export const addCreditsCommand = {
  data: new CommandBuilder()
    .setName("add-credits")
    .setDescription("Add shop credit to a player equal to the dollars they have donated")
    .setDefaultMemberPermissions(8n)
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName("player")
        .setDescription("Search GitHub, Discord, character name, or game user ID")
        .setAutocomplete(true)
        .setRequired(true),
    )
    .addNumberOption((option) =>
      option
        .setName("dollars")
        .setDescription("Donated amount in USD to convert into shop credit")
        .setMinValue(0.01)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("note")
        .setDescription("Optional note stored with the credit grant")
        .setRequired(false),
    ),
  handler: async (interaction: CommandInteraction) => {
    if (!isAdministrator(interaction)) {
      return interaction.reply({
        content: "Administrator permission is required.",
        flags: 64,
      });
    }

    const playerSelector = interaction.options.getString("player", true)!.trim();
    const dollars = interaction.options.getNumber("dollars", true)!;
    const note = interaction.options.getString("note", false) ?? undefined;
    const cents = Math.round(dollars * 100);
    if (!Number.isFinite(dollars) || cents <= 0) {
      return interaction.reply({
        content: "Enter a positive dollar amount to grant.",
        flags: 64,
      });
    }

    interaction.deferReply({ flags: 64 });

    try {
      // Wallet selectors must be resolved through their linked profile first so
      // the credit lands on the Discord account that owns the ledger.
      let targetDiscordId: string | null = null;
      if (playerSelector.startsWith("profile:")) {
        targetDiscordId = playerSelector.slice("profile:".length).trim() || null;
      } else {
        const profile = await getPlayerProfile(playerSelector);
        targetDiscordId = profile?.discordUserId ?? null;
      }
      if (!targetDiscordId) {
        return interaction.editReply({
          content:
            "That player has no linked profile. Only players who linked Discord with GitHub (through account linking) can receive credit.",
        });
      }

      const result = await addCreditsToPlayer({
        discordId: targetDiscordId,
        dollars,
        grantedByDiscordId: interactionDiscordId(interaction),
        note,
      });

      if (result.status === "no-profile") {
        return interaction.editReply({
          content: "That player has no linked profile to grant credit to.",
        });
      }
      if (result.status === "not-linked") {
        return interaction.editReply({
          content:
            "That Discord account has no linked GitHub account, so donation credit cannot be tracked for it.",
        });
      }

      const dollarLabel = `$${(result.cents / 100).toFixed(2)}`;
      const bonusLabel = `$${(result.totalBonusCents / 100).toFixed(2)}`;
      return interaction.editReply({
        content: `Added **${dollarLabel}** of donation credit — bonus credit balance is now **${bonusLabel}**. It stacks on top of their GitHub sponsor donations in the pack shop.`,
      });
    } catch (error) {
      console.error("[add-credits] Credit grant failed:", error);
      return interaction.editReply({
        content: "The credit could not be added right now. Please try again later.",
      });
    }
  },
};

export async function handleAddCreditsAutocomplete(autocomplete: AutocompleteContext) {
  const focused = autocomplete.getFocusedOption();
  if (!focused || focused.name !== "player") {
    autocomplete.respond([]);
    return;
  }

  try {
    // Only linked profiles can hold credit, so the picker lists exactly the
    // `profile:<discordId>` rows (unlike /profile, which also offers wallets).
    const players = (await searchPlayers(String(focused.value ?? ""))).filter((player) =>
      player.selector.startsWith("profile:"),
    );
    autocomplete.respond(
      players.map((player) => ({
        name: player.label.slice(0, 100),
        value: player.selector,
      })),
    );
  } catch (error) {
    console.error("[add-credits] Autocomplete failed:", error);
    autocomplete.respond([]);
  }
}
