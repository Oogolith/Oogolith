import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ChannelSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ComponentType,
    ChannelType,
    EmbedBuilder,
    LabelBuilder,
    RadioGroupBuilder,
    InteractionContextType,
    Events,
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getColor } from '../../config/bot.js';

/* ────────────────────────────────────────────────────────────────────────────
 *  CONSTANTS
 * ──────────────────────────────────────────────────────────────────────────── */

const MAX_FIELDS = 25;
const MAX_COMPONENTS = 25; // 5 rows x 5 buttons, or 25 dropdown options
const IDLE_TIMEOUT = 900_000; // 15 minutes of inactivity
const CLICK_COOLDOWN_MS = 1500;

// Panels (the posted components + their roles + hidden messages) are saved here
// so they keep working after the bot restarts.
const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'embed_panels.json');

const COLOR_PRESETS = [
    { label: 'Primary (Blue)',        value: '#336699', emoji: '' },
    { label: 'Success (Green)',       value: '#57F287', emoji: '' },
    { label: 'Error (Red)',           value: '#ED4245', emoji: '' },
    { label: 'Warning (Yellow)',      value: '#FEE75C', emoji: '' },
    { label: 'Info (Bright Blue)',    value: '#3498DB', emoji: '' },
    { label: 'Blurple (Discord)',     value: '#5865F2', emoji: '' },
    { label: 'Fuchsia',              value: '#EB459E', emoji: '' },
    { label: 'Gold',                  value: '#F1C40F', emoji: '' },
    { label: 'White',                 value: '#FFFFFF', emoji: '' },
    { label: 'Dark',                  value: '#202225', emoji: '' },
    { label: 'Custom Hex...',         value: '__custom__', emoji: '' },
];

const BEHAVIORS = [
    { label: 'Toggle — add if missing, remove if owned', value: 'toggle' },
    { label: 'Add only — never removes the role',        value: 'add' },
    { label: 'Remove only — never adds the role',        value: 'remove' },
];

const BUTTON_STYLES = {
    primary:   { label: 'Blurple', style: ButtonStyle.Primary,   emoji: '🟦' },
    secondary: { label: 'Grey',    style: ButtonStyle.Secondary, emoji: '⬜' },
    success:   { label: 'Green',   style: ButtonStyle.Success,   emoji: '🟩' },
    danger:    { label: 'Red',     style: ButtonStyle.Danger,    emoji: '🟥' },
};

/* ────────────────────────────────────────────────────────────────────────────
 *  GENERAL HELPERS
 * ──────────────────────────────────────────────────────────────────────────── */

function isValidUrl(str) {
    try {
        const url = new URL(str);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function isValidHex(str) {
    return /^#[0-9A-Fa-f]{6}$/.test(str);
}

function resolveEmbedColor(value) {
    try {
        const resolved = getColor(value || 'primary');
        if (typeof resolved === 'number' && Number.isFinite(resolved) && resolved >= 0 && resolved <= 0xffffff) {
            return resolved;
        }
    } catch {
        // ignore invalid value and fall through to primary
    }
    return getColor('primary');
}

function generateId(bytes = 4) {
    return crypto.randomBytes(bytes).toString('hex');
}

function createInitialState() {
    return {
        title:       null,
        description: null,
        color:       getColor('primary'),
        author:      null,
        footer:      null,
        thumbnail:   null,
        image:       null,
        timestamp:   false,
        fields:      [],

        // components
        componentMode:        'buttons', // 'buttons' | 'select'
        componentPlaceholder: null,      // dropdown placeholder
        buttonStyle:          'primary', // key of BUTTON_STYLES
        components:           [],        // see makeComponentItem()

        // last message this session posted (so it can be edited later)
        lastPosted: null, // { panelId, channelId, messageId }
    };
}

/** Accepts a unicode emoji or a custom emoji like <:name:123> / <a:name:123>. Returns a value usable by setEmoji(), or null. */
function parseEmoji(str) {
    if (!str) return null;
    const s = str.trim();
    const custom = s.match(/^<(a?):([A-Za-z0-9_]{2,32}):(\d{15,25})>$/);
    if (custom) return { id: custom[3], name: custom[2], animated: custom[1] === 'a' };
    if (/^(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)[\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]*)+$/u.test(s)) {
        return s;
    }
    return null;
}

function hasEmbedContent(state) {
    return !!(state.title || state.description || state.fields.length > 0 || state.author?.name);
}

/* ────────────────────────────────────────────────────────────────────────────
 *  PANEL STORAGE (JSON file — swap these 4 functions for your DB if you like)
 * ──────────────────────────────────────────────────────────────────────────── */

let panelCache = null;
let writeChain = Promise.resolve();

async function loadPanels() {
    if (panelCache) return panelCache;
    try {
        panelCache = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.error('Embed panel store is unreadable, backing it up and starting fresh:', error.message);
            await fs.copyFile(STORE_FILE, `${STORE_FILE}.corrupt-${Date.now()}`).catch(() => {});
        }
        panelCache = {};
    }
    return panelCache;
}

function persistPanels() {
    writeChain = writeChain
        .then(async () => {
            await fs.mkdir(DATA_DIR, { recursive: true });
            const tmp = `${STORE_FILE}.tmp`;
            await fs.writeFile(tmp, JSON.stringify(panelCache, null, 2), 'utf8');
            await fs.rename(tmp, STORE_FILE);
        })
        .catch(error => logger.error('Failed to save embed panels:', error));
    return writeChain;
}

async function getPanel(panelId) {
    const panels = await loadPanels();
    return panels[panelId] ?? null;
}

async function savePanel(panelId, panel) {
    const panels = await loadPanels();
    panels[panelId] = panel;
    await persistPanels();
}

async function deletePanel(panelId) {
    const panels = await loadPanels();
    if (panels[panelId]) {
        delete panels[panelId];
        await persistPanels();
    }
}

function makePanelRecord(state, extras) {
    return {
        ...extras,
        color:                resolveEmbedColor(state.color),
        componentMode:        state.componentMode,
        componentPlaceholder: state.componentPlaceholder,
        buttonStyle:          state.buttonStyle,
        components:           state.components.map(c => ({ ...c })),
        updatedAt:            Date.now(),
    };
}

/* ────────────────────────────────────────────────────────────────────────────
 *  COMPONENT BUILDING (shared by the builder and the live click handler)
 * ──────────────────────────────────────────────────────────────────────────── */

function describeItem(item, guild) {
    if (item.roleId) {
        const role = guild?.roles?.cache?.get(item.roleId);
        return role ? `Role: ${role.name}` : 'Role';
    }
    return item.hiddenMessage ? 'Click to view' : null;
}

/** Builds the action rows for a panel. `cfg` is either the builder state or a stored panel record. */
function buildComponentRows(panelId, cfg, guild) {
    const items = (cfg.components || []).slice(0, MAX_COMPONENTS);
    if (items.length === 0) return [];

    if (cfg.componentMode === 'select') {
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`ebs:${panelId}`)
            .setPlaceholder((cfg.componentPlaceholder || 'Make a selection...').substring(0, 150))
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
                items.map(item => {
                    const option = new StringSelectMenuOptionBuilder()
                        .setLabel(item.label.substring(0, 100))
                        .setValue(item.id);
                    const emoji = parseEmoji(item.emoji);
                    if (emoji) option.setEmoji(emoji);
                    const desc = describeItem(item, guild);
                    if (desc) option.setDescription(desc.substring(0, 100));
                    return option;
                }),
            );
        return [new ActionRowBuilder().addComponents(menu)];
    }

    const style = (BUTTON_STYLES[cfg.buttonStyle] ?? BUTTON_STYLES.primary).style;
    const buttons = items.map(item => {
        const btn = new ButtonBuilder()
            .setCustomId(`ebc:${panelId}:${item.id}`)
            .setLabel(item.label.substring(0, 80))
            .setStyle(style);
        const emoji = parseEmoji(item.emoji);
        if (emoji) btn.setEmoji(emoji);
        return btn;
    });

    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }
    return rows;
}

/* ────────────────────────────────────────────────────────────────────────────
 *  ROLE HELPERS
 * ──────────────────────────────────────────────────────────────────────────── */

function resolveRole(guild, input) {
    const raw = (input || '').trim();
    if (!raw) return null;

    const mention = raw.match(/^<@&(\d+)>$/)?.[1];
    const id = mention ?? (/^\d{15,25}$/.test(raw) ? raw : null);
    if (id) return guild.roles.cache.get(id) ?? null;

    const name = raw.replace(/^@/, '').toLowerCase();
    return guild.roles.cache.find(r => r.name.toLowerCase() === name) ?? null;
}

/** Returns an error string if this role must not be used in a panel, otherwise null. */
function validateRoleForUse(role, invokerMember, guild) {
    if (role.id === guild.id) return 'You cannot use @everyone as a panel role.';
    if (role.managed) return `**${role.name}** is managed by an integration and cannot be assigned manually.`;
    if (!role.editable) {
        return `I can't assign **${role.name}** — it is above (or equal to) my highest role, or I lack the **Manage Roles** permission.`;
    }
    const isOwner = guild.ownerId === invokerMember?.id;
    if (!isOwner && invokerMember && invokerMember.roles.highest.comparePositionTo(role) <= 0) {
        return `You can only create panels for roles that are **below your own highest role**. **${role.name}** is not.`;
    }
    return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 *  LIVE CLICK HANDLER  (this is what makes buttons/dropdowns actually work)
 * ──────────────────────────────────────────────────────────────────────────── */

const handledInteractions = new WeakSet();
const clickCooldowns = new Map();

function isPanelInteraction(interaction) {
    return (
        (interaction.isButton() || interaction.isStringSelectMenu()) &&
        (interaction.customId.startsWith('ebc:') || interaction.customId.startsWith('ebs:'))
    );
}

function fillTemplate(text, ctx) {
    return text
        .replaceAll('{user}', `<@${ctx.userId}>`)
        .replaceAll('{username}', ctx.username)
        .replaceAll('{server}', ctx.server)
        .replaceAll('{role}', ctx.role ?? 'this role');
}

/**
 * Handles a click on a posted panel component. Returns true if the interaction was one of ours.
 * Safe to call from your own interactionCreate handler AND from the auto-registered listener
 * (an interaction is never handled twice).
 */
export async function handleEmbedPanelInteraction(interaction) {
    if (!isPanelInteraction(interaction) || handledInteractions.has(interaction)) return false;
    handledInteractions.add(interaction);

    try {
        if (!interaction.inGuild() || !interaction.guild) {
            await interaction.reply({ content: 'This can only be used in a server.', flags: MessageFlags.Ephemeral });
            return true;
        }

        const isSelect = interaction.isStringSelectMenu();
        const [, panelId, buttonItemId] = interaction.customId.split(':');
        const itemId = isSelect ? interaction.values[0] : buttonItemId;

        const cooldownKey = `${interaction.user.id}:${panelId}`;
        const now = Date.now();
        if ((clickCooldowns.get(cooldownKey) ?? 0) > now) {
            await interaction.reply({ content: '⏳ Slow down a little!', flags: MessageFlags.Ephemeral });
            return true;
        }
        clickCooldowns.set(cooldownKey, now + CLICK_COOLDOWN_MS);
        setTimeout(() => clickCooldowns.delete(cooldownKey), CLICK_COOLDOWN_MS + 500).unref?.();

        const panel = await getPanel(panelId);
        if (!panel) {
            await interaction.reply({
                content: '❌ This panel is no longer active. Ask a moderator to repost it.',
                flags: MessageFlags.Ephemeral,
            });
            return true;
        }

        const item = panel.components?.find(c => c.id === itemId);
        if (!item) {
            await interaction.reply({ content: '❌ This option no longer exists.', flags: MessageFlags.Ephemeral });
            return true;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guild = interaction.guild;
        let roleLine = null;
        let roleName = null;

        if (item.roleId) {
            const role = guild.roles.cache.get(item.roleId) ?? (await guild.roles.fetch(item.roleId).catch(() => null));

            if (!role) {
                roleLine = '⚠️ The role linked to this option no longer exists.';
            } else {
                roleName = role.name;
                if (!role.editable) {
                    roleLine = `⚠️ I can't manage <@&${role.id}> right now. Ask an admin to move my role above it.`;
                } else {
                    const member = await guild.members.fetch(interaction.user.id);
                    const has = member.roles.cache.has(role.id);
                    const behavior = item.behavior || 'toggle';
                    const reason = `Embed panel ${panelId}`;

                    try {
                        if (behavior === 'add' || (behavior === 'toggle' && !has)) {
                            if (has) {
                                roleLine = `ℹ️ You already have <@&${role.id}>.`;
                            } else {
                                await member.roles.add(role, reason);
                                roleLine = `✅ You received <@&${role.id}>.`;
                            }
                        } else if (!has) {
                            roleLine = `ℹ️ You don't have <@&${role.id}>.`;
                        } else {
                            await member.roles.remove(role, reason);
                            roleLine = `✅ <@&${role.id}> was removed from you.`;
                        }
                    } catch (error) {
                        logger.warn('Embed panel role change failed:', error.message);
                        roleLine = '⚠️ Something went wrong while updating your roles. Please tell a moderator.';
                    }
                }
            }
        }

        const payload = { allowedMentions: { parse: [] } };

        if (item.hiddenMessage) {
            const text = fillTemplate(item.hiddenMessage, {
                userId:   interaction.user.id,
                username: interaction.user.username,
                server:   guild.name,
                role:     roleName,
            });
            payload.embeds = [
                new EmbedBuilder()
                    .setDescription(text.substring(0, 4096))
                    .setColor(typeof panel.color === 'number' ? panel.color : resolveEmbedColor(null)),
            ];
        }

        if (roleLine) payload.content = roleLine;
        if (!payload.content && !payload.embeds) payload.content = '✅ Done.';

        await interaction.editReply(payload);

        // Dropdowns keep showing the last pick on the client; re-sending the rows resets them
        // so the same option can be chosen again (needed for toggling).
        if (isSelect) {
            interaction.message
                ?.edit({ components: buildComponentRows(panelId, panel, guild) })
                .catch(() => {});
        }
    } catch (error) {
        logger.error('Error handling embed panel interaction:', error);
        const fallback = { content: '❌ Something went wrong. Please try again later.', flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(fallback).catch(() => {});
        } else {
            await interaction.reply(fallback).catch(() => {});
        }
    }
    return true;
}

/**
 * Registers a global listener so posted panels work. Called automatically the first time
 * /embedbuilder runs, but to keep panels working right after a restart, call it once from
 * your ready event:   registerEmbedComponentHandler(client);
 * (If your own interactionCreate already calls handleEmbedPanelInteraction, you don't need this.)
 */
export function registerEmbedComponentHandler(client) {
    if (client.__embedPanelHandlerRegistered) return;
    client.__embedPanelHandlerRegistered = true;
    client.on(Events.InteractionCreate, interaction => {
        if (isPanelInteraction(interaction)) {
            handleEmbedPanelInteraction(interaction).catch(error =>
                logger.error('Embed panel listener error:', error),
            );
        }
    });
}

/* ────────────────────────────────────────────────────────────────────────────
 *  EMBED PREVIEW / DASHBOARD
 * ──────────────────────────────────────────────────────────────────────────── */

function buildPreviewEmbed(state) {
    const embed = new EmbedBuilder();

    if (state.title)       embed.setTitle(state.title.substring(0, 256));
    if (state.description) embed.setDescription(state.description.substring(0, 4096));

    embed.setColor(resolveEmbedColor(state.color));

    if (state.author?.name) {
        const obj = { name: state.author.name.substring(0, 256) };
        if (state.author.iconUrl && isValidUrl(state.author.iconUrl)) obj.iconURL = state.author.iconUrl;
        if (state.author.url   && isValidUrl(state.author.url))      obj.url     = state.author.url;
        embed.setAuthor(obj);
    }

    if (state.footer?.text) {
        const obj = { text: state.footer.text.substring(0, 2048) };
        if (state.footer.iconUrl && isValidUrl(state.footer.iconUrl)) obj.iconURL = state.footer.iconUrl;
        embed.setFooter(obj);
    }

    if (state.thumbnail && isValidUrl(state.thumbnail)) embed.setThumbnail(state.thumbnail);
    if (state.image     && isValidUrl(state.image))     embed.setImage(state.image);
    if (state.timestamp) embed.setTimestamp();

    if (state.fields.length > 0) embed.addFields(state.fields.slice(0, 25));

    if (!hasEmbedContent(state)) {
        embed.setDescription('*(Empty — use the menu below to add content)*');
    }

    return embed;
}

/** The embed that actually gets posted (no placeholder text). */
function buildFinalEmbed(state) {
    const embed = buildPreviewEmbed(state);
    if (embed.data.description === '*(Empty — use the menu below to add content)*') {
        embed.setDescription(null);
    }
    return embed;
}

function buildDashboardEmbed(state) {
    const trunc = (str, n) =>
        str.length > n ? str.substring(0, n) + '…' : str;

    const modeLabel = state.componentMode === 'select' ? 'Dropdown' : 'Buttons';

    const lines = [
        `**Title** › ${state.title ?`\`${trunc(state.title, 40)}\`` : '`Not set`'}`,
        `**Description** › ${state.description ?`${state.description.length} character(s)`: '`Not set`'}`,
        `**Color** › ${state.color ?`\`${state.color}\`` : '`Default`'}`,
        `**Author** › ${state.author?.name ?`\`${trunc(state.author.name, 30)}\`` : '`Not set`'}`,
        `**Footer** › ${state.footer?.text ?`\`${trunc(state.footer.text, 30)}\`` : '`Not set`'}`,
        `**Thumbnail** › ${state.thumbnail ? '✅ Set' : '`Not set`'}`,
        `**Image** › ${state.image ? '✅ Set' : '`Not set`'}`,
        `**Timestamp** › ${state.timestamp ? '✅ Enabled' : '`Disabled`'}`,
        `**Fields** › ${state.fields.length} / ${MAX_FIELDS}`,
        `**Components** › ${state.components.length} / ${MAX_COMPONENTS} · ${modeLabel}`,
        `**Posted Panel** › ${state.lastPosted ? '✅ Linked (use Update Posted)' : '`None`'}`,
    ];

    const embed = new EmbedBuilder()
        .setTitle('Embed Builder — Control Panel')
        .setDescription(lines.join('\n'))
        .setColor(getColor('info'))
        .setFooter({ text: 'The preview above updates live · Closes after 15 min of inactivity' });

    if (state.components.length > 0) {
        const rows = [];
        let used = 0;
        for (let i = 0; i < state.components.length; i++) {
            const it = state.components[i];
            const line =
                `${i + 1}. ${it.emoji ? `${it.emoji} ` : ''}**${trunc(it.label, 25)}**` +
                `${it.roleId ? ` → <@&${it.roleId}>` : ''}${it.hiddenMessage ? ' · 💬' : ''}`;
            if (used + line.length + 1 > 960) {
                rows.push(`…and ${state.components.length - i} more`);
                break;
            }
            rows.push(line);
            used += line.length + 1;
        }
        embed.addFields({ name: 'Components  (💬 = has hidden message)', value: rows.join('\n') });
    }

    return embed;
}

function buildMainMenu(state) {
    const primaryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('eb_main_edit_content')
            .setLabel('Edit Content')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✏️'),
        new ButtonBuilder()
            .setCustomId('eb_main_set_color')
            .setLabel('Set Color')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🎨'),
        new ButtonBuilder()
            .setCustomId('eb_main_set_images')
            .setLabel('Set Images')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🖼️'),
        new ButtonBuilder()
            .setCustomId('eb_main_post_embed')
            .setLabel('Post Embed')
            .setStyle(ButtonStyle.Success)
            .setEmoji('📤'),
    );

    const secondaryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('eb_main_add_field')
            .setLabel(`Add Field (${state.fields.length}/${MAX_FIELDS})`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji('➕'),
        new ButtonBuilder()
            .setCustomId('eb_main_edit_field')
            .setLabel('Edit Field')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📝')
            .setDisabled(state.fields.length === 0),
        new ButtonBuilder()
            .setCustomId('eb_main_remove_field')
            .setLabel('Remove Field')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('➖')
            .setDisabled(state.fields.length === 0),
        new ButtonBuilder()
            .setCustomId('eb_main_toggle_timestamp')
            .setLabel(state.timestamp ? 'Disable Timestamp' : 'Enable Timestamp')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🕐'),
    );

    const tertiaryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('eb_main_reorder_fields')
            .setLabel('Reorder Fields')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('↕️')
            .setDisabled(state.fields.length < 2),
        new ButtonBuilder()
            .setCustomId('eb_main_json_export')
            .setLabel('JSON / Raw Data')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📋'),
        new ButtonBuilder()
            .setCustomId('eb_main_update_posted')
            .setLabel('Update Posted')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🔄')
            .setDisabled(!state.lastPosted),
        new ButtonBuilder()
            .setCustomId('eb_main_reset_all')
            .setLabel('Reset Everything')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️'),
    );

    const componentRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('eb_main_add_component')
            .setLabel(`Add Component (${state.components.length}/${MAX_COMPONENTS})`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🧩'),
        new ButtonBuilder()
            .setCustomId('eb_main_edit_component')
            .setLabel('Edit Component')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🛠️')
            .setDisabled(state.components.length === 0),
        new ButtonBuilder()
            .setCustomId('eb_main_remove_component')
            .setLabel('Remove Component')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('✖️')
            .setDisabled(state.components.length === 0),
        new ButtonBuilder()
            .setCustomId('eb_main_component_settings')
            .setLabel('Component Settings')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⚙️'),
    );

    const identityRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('eb_main_set_author')
            .setLabel('Set Author')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('👤'),
        new ButtonBuilder()
            .setCustomId('eb_main_set_footer')
            .setLabel('Set Footer')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔻'),
    );

    return [primaryRow, secondaryRow, tertiaryRow, componentRow, identityRow];
}

async function refreshDashboard(interaction, state) {
    return await InteractionHelper.safeEditReply(interaction, {
        embeds: [buildPreviewEmbed(state), buildDashboardEmbed(state)],
        components: buildMainMenu(state),
    });
}

/* ────────────────────────────────────────────────────────────────────────────
 *  EXISTING HANDLERS (content, color, author, footer, images, fields)
 * ──────────────────────────────────────────────────────────────────────────── */

async function handleEditContent(selectInteraction, rootInteraction, state) {
    const modal = new ModalBuilder()
        .setCustomId('eb_content')
        .setTitle('Edit Content')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('eb_title')
                    .setLabel('Title (max 256 characters)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.title || '')
                    .setMaxLength(256)
                    .setRequired(false)
                    .setPlaceholder('My Embed Title'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('eb_description')
                    .setLabel('Description (max 4000 characters)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(state.description ? state.description.substring(0, 4000) : '')
                    .setMaxLength(4000)
                    .setRequired(false)
                    .setPlaceholder('Write your embed description here...'),
            ),
        );

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'eb_content' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    await submitted.deferUpdate().catch(() => {});

    state.title       = submitted.fields.getTextInputValue('eb_title').trim()       || null;
    state.description = submitted.fields.getTextInputValue('eb_description').trim() || null;

    await refreshDashboard(rootInteraction, state);
}

async function handleSetColor(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate().catch(() => {});

    const colorSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_color_pick')
        .setPlaceholder('Choose a color...')
        .addOptions(
            COLOR_PRESETS.map(c =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(c.label)
                    .setValue(c.value)
                    .setEmoji(c.emoji)
                    .setDescription(c.value !== '__custom__' ? c.value : 'Enter your own #RRGGBB value'),
            ),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Set Color')
                .setDescription(
                    'Select a preset color or choose **Custom Hex** to enter your own `#RRGGBB` value.',
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(colorSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const colorCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_color_pick',
        time: 60_000,
        max: 1,
    });

    colorCollector.on('collect', async colorInter => {
        try {
        const picked = colorInter.values[0];

        if (picked === '__custom__') {
            const hexModal = new ModalBuilder()
                .setCustomId('eb_custom_hex')
                .setTitle('Custom Color')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('hex_value')
                            .setLabel('Hex Color Code')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('#5865F2')
                            .setMaxLength(7)
                            .setMinLength(7)
                            .setRequired(true),
                    ),
                );

            const shown = await InteractionHelper.safeShowModal(colorInter, hexModal);
            if (!shown) return;

            const hexSubmit = await colorInter
                .awaitModalSubmit({
                    filter: i =>
                        i.customId === 'eb_custom_hex' && i.user.id === colorInter.user.id,
                    time: 60_000,
                })
                .catch(() => null);

            if (!hexSubmit) return;

            const hex = hexSubmit.fields.getTextInputValue('hex_value').trim();
            if (!isValidHex(hex)) {
                await replyUserError(hexSubmit, {
                    type: ErrorTypes.USER_INPUT,
                    message: `\`${hex}\` is not a valid hex color. Use the format \`#RRGGBB\` (e.g. \`#5865F2\`).`,
                });
                return;
            }

            state.color = hex;
            await hexSubmit.deferUpdate().catch(() => {});
        } else {
            state.color = picked;
            await colorInter.deferUpdate().catch(() => {});
        }

        await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder color picker interaction failed:', error.message);
        }
    });
}

async function handleSetAuthor(selectInteraction, rootInteraction, state) {
    const modal = new ModalBuilder()
        .setCustomId('eb_author')
        .setTitle('Set Author')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('author_name')
                    .setLabel('Author Name (leave blank to remove)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.author?.name || '')
                    .setMaxLength(256)
                    .setRequired(false)
                    .setPlaceholder('Your Name'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('author_icon')
                    .setLabel('Author Icon URL (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.author?.iconUrl || '')
                    .setRequired(false)
                    .setPlaceholder('https://example.com/icon.png'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('author_url')
                    .setLabel('Author Link URL (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.author?.url || '')
                    .setRequired(false)
                    .setPlaceholder('https://example.com'),
            ),
        );

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'eb_author' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const name    = submitted.fields.getTextInputValue('author_name').trim();
    const iconUrl = submitted.fields.getTextInputValue('author_icon').trim();
    const url     = submitted.fields.getTextInputValue('author_url').trim();

    if (iconUrl && !isValidUrl(iconUrl)) {
        await replyUserError(submitted, {
            type: ErrorTypes.USER_INPUT,
            message: 'Author icon URL must be a valid `https://` URL.',
        });
        return;
    }
    if (url && !isValidUrl(url)) {
        await replyUserError(submitted, {
            type: ErrorTypes.USER_INPUT,
            message: 'Author link URL must be a valid `https://` URL.',
        });
        return;
    }

    state.author = name ? { name, iconUrl: iconUrl || null, url: url || null } : null;

    await submitted.deferUpdate().catch(() => {});
    await refreshDashboard(rootInteraction, state);
}

async function handleSetFooter(selectInteraction, rootInteraction, state) {
    const modal = new ModalBuilder()
        .setCustomId('eb_footer')
        .setTitle('Set Footer')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('footer_text')
                    .setLabel('Footer Text (leave blank to remove)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.footer?.text || '')
                    .setMaxLength(2048)
                    .setRequired(false)
                    .setPlaceholder('Built with TitanBot'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('footer_icon')
                    .setLabel('Footer Icon URL (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.footer?.iconUrl || '')
                    .setRequired(false)
                    .setPlaceholder('https://example.com/icon.png'),
            ),
        );

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'eb_footer' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const text    = submitted.fields.getTextInputValue('footer_text').trim();
    const iconUrl = submitted.fields.getTextInputValue('footer_icon').trim();

    if (iconUrl && !isValidUrl(iconUrl)) {
        await replyUserError(submitted, {
            type: ErrorTypes.USER_INPUT,
            message: 'Footer icon URL must be a valid `https://` URL.',
        });
        return;
    }

    state.footer = text ? { text, iconUrl: iconUrl || null } : null;

    await submitted.deferUpdate().catch(() => {});
    await refreshDashboard(rootInteraction, state);
}

async function handleSetImages(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate().catch(() => {});

    const imageSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_image_pick')
        .setPlaceholder('What would you like to change?')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Set Thumbnail')
                .setDescription('Small image displayed in the top-right corner')
                .setValue('set_thumbnail')
                .setEmoji('🖼️'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Set Large Image')
                .setDescription('Full-width banner image at the bottom')
                .setValue('set_image')
                .setEmoji('📸'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Clear Thumbnail')
                .setDescription('Remove the current thumbnail')
                .setValue('clear_thumbnail')
                .setEmoji('🗑️'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Clear Large Image')
                .setDescription('Remove the current large image')
                .setValue('clear_image')
                .setEmoji('🗑️'),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Set Images')
                .setDescription('Choose which image to set or remove.')
                .addFields(
                    { name: 'Thumbnail',    value: state.thumbnail ? `[View](${state.thumbnail})` : '`Not set`', inline: true },
                    { name: 'Large Image',  value: state.image     ? `[View](${state.image})`     : '`Not set`', inline: true },
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(imageSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const imgMenuCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_image_pick',
        time: 60_000,
        max: 1,
    });

    imgMenuCollector.on('collect', async imgInter => {
        try {
        const pick = imgInter.values[0];

        if (pick === 'clear_thumbnail') {
            state.thumbnail = null;
            await imgInter.deferUpdate();
            await refreshDashboard(rootInteraction, state);
            return;
        }
        if (pick === 'clear_image') {
            state.image = null;
            await imgInter.deferUpdate();
            await refreshDashboard(rootInteraction, state);
            return;
        }

        const isThumb = pick === 'set_thumbnail';

        const urlModal = new ModalBuilder()
            .setCustomId('eb_image_url')
            .setTitle(isThumb ? 'Set Thumbnail' : 'Set Large Image')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('image_url')
                        .setLabel('Image URL')
                        .setStyle(TextInputStyle.Short)
                        .setValue(isThumb ? (state.thumbnail || '') : (state.image || ''))
                        .setRequired(true)
                        .setPlaceholder('https://example.com/image.png'),
                ),
            );

        const shown = await InteractionHelper.safeShowModal(imgInter, urlModal);
        if (!shown) return;

        const submitted = await imgInter
            .awaitModalSubmit({
                filter: i =>
                    i.customId === 'eb_image_url' && i.user.id === imgInter.user.id,
                time: 60_000,
            })
            .catch(() => null);

        if (!submitted) return;

        const url = submitted.fields.getTextInputValue('image_url').trim();
        if (!isValidUrl(url)) {
            await replyUserError(submitted, {
                type: ErrorTypes.USER_INPUT,
                message: 'Image URL must be a valid `https://` link to a publicly accessible image.',
            });
            return;
        }

        if (isThumb) state.thumbnail = url;
        else         state.image     = url;

        await submitted.deferUpdate().catch(() => {});
        await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder image picker interaction failed:', error.message);
        }
    });
}

async function handleAddField(selectInteraction, rootInteraction, state) {
    if (state.fields.length >= MAX_FIELDS) {
        await selectInteraction.deferUpdate();
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: `Embeds can have a maximum of ${MAX_FIELDS} fields.`,
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId('eb_add_field')
        .setTitle('Add Field');

    const fieldNameLabel = new LabelBuilder()
        .setLabel('Field Name (max 256 characters)')
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('field_name')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(256)
                .setRequired(true)
                .setPlaceholder('Field Title'),
        );

    const fieldValueLabel = new LabelBuilder()
        .setLabel('Field Value (max 1024 characters)')
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('field_value')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1024)
                .setRequired(true)
                .setPlaceholder('Field content goes here...'),
        );

    const inlineRadio = new RadioGroupBuilder()
        .setCustomId('field_inline')
        .setRequired(false)
        .addOptions([
            { label: 'No — full width', value: 'no' },
            { label: 'Yes — side-by-side', value: 'yes' },
        ]);

    const inlineLabel = new LabelBuilder()
        .setLabel('Display inline?')
        .setRadioGroupComponent(inlineRadio);

    modal.addLabelComponents(fieldNameLabel, fieldValueLabel, inlineLabel);

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'eb_add_field' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const name     = submitted.fields.getTextInputValue('field_name').trim();
    const value    = submitted.fields.getTextInputValue('field_value').trim();
    const inline   = submitted.fields.getRadioGroup('field_inline') === 'yes';

    state.fields.push({ name, value, inline });

    await submitted.deferUpdate().catch(() => {});
    await refreshDashboard(rootInteraction, state);
}

async function handleEditField(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_edit_field_pick')
        .setPlaceholder('Select a field to edit...')
        .addOptions(
            state.fields.slice(0, 25).map((f, i) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${f.name.substring(0, 50)}`)
                    .setDescription(
                        `${f.value.substring(0, 80)}${f.value.length > 80 ? '…' : ''} · ${f.inline ? 'Inline' : 'Block'}`,
                    )
                    .setValue(String(i))
                    .setEmoji('📝'),
            ),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Edit Field')
                .setDescription('Select the field you want to modify.')
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(pickSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const pickCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_edit_field_pick',
        time: 60_000,
        max: 1,
    });

    pickCollector.on('collect', async pickInter => {
        try {
        const idx   = parseInt(pickInter.values[0], 10);
        const field = state.fields[idx];
        if (!field) { await pickInter.deferUpdate(); return; }

        const modal = new ModalBuilder()
            .setCustomId('eb_edit_field_modal')
            .setTitle(`Edit Field ${idx + 1}`);

        const editNameLabel = new LabelBuilder()
            .setLabel('Field Name')
            .setTextInputComponent(
                new TextInputBuilder()
                    .setCustomId('field_name')
                    .setStyle(TextInputStyle.Short)
                    .setValue(field.name)
                    .setMaxLength(256)
                    .setRequired(true),
            );

        const editValueLabel = new LabelBuilder()
            .setLabel('Field Value')
            .setTextInputComponent(
                new TextInputBuilder()
                    .setCustomId('field_value')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(field.value.substring(0, 1024))
                    .setMaxLength(1024)
                    .setRequired(true),
            );

        const editInlineRadio = new RadioGroupBuilder()
            .setCustomId('field_inline')
            .setRequired(false)
            .addOptions([
                { label: 'No — full width', value: 'no', default: !field.inline },
                { label: 'Yes — side-by-side', value: 'yes', default: !!field.inline },
            ]);

        const editInlineLabel = new LabelBuilder()
            .setLabel('Display inline?')
            .setRadioGroupComponent(editInlineRadio);

        modal.addLabelComponents(editNameLabel, editValueLabel, editInlineLabel);

        const shown = await InteractionHelper.safeShowModal(pickInter, modal);
        if (!shown) return;

        const submitted = await pickInter
            .awaitModalSubmit({
                filter: i =>
                    i.customId === 'eb_edit_field_modal' && i.user.id === pickInter.user.id,
                time: 120_000,
            })
            .catch(() => null);

        if (!submitted) return;

        const name   = submitted.fields.getTextInputValue('field_name').trim();
        const value  = submitted.fields.getTextInputValue('field_value').trim();
        const inline = submitted.fields.getRadioGroup('field_inline') === 'yes';

        state.fields[idx] = { name, value, inline };

        await submitted.deferUpdate().catch(() => {});
        await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder field edit interaction failed:', error.message);
        }
    });
}

async function handleRemoveField(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_remove_field_pick')
        .setPlaceholder('Select a field to remove...')
        .addOptions(
            state.fields.slice(0, 25).map((f, i) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${f.name.substring(0, 50)}`)
                    .setDescription(
                        `${f.value.substring(0, 90)}${f.value.length > 90 ? '…' : ''}`,
                    )
                    .setValue(String(i))
                    .setEmoji('➖'),
            ),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Remove Field')
                .setDescription('Select the field you want to delete.')
                .setColor(getColor('warning')),
        ],
        components: [new ActionRowBuilder().addComponents(pickSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const removeCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_remove_field_pick',
        time: 60_000,
        max: 1,
    });

    removeCollector.on('collect', async removeInter => {
        try {
            await removeInter.deferUpdate();
            const idx = parseInt(removeInter.values[0], 10);
            state.fields.splice(idx, 1);
            await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder field removal interaction failed:', error.message);
        }
    });
}

async function handleReorderFields(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_reorder_pick')
        .setPlaceholder('Select a field to move...')
        .addOptions(
            state.fields.slice(0, 25).map((f, i) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${f.name.substring(0, 50)}`)
                    .setDescription(
                        `${f.value.substring(0, 90)}${f.value.length > 90 ? '…' : ''}`,
                    )
                    .setValue(String(i))
                    .setEmoji('↕️'),
            ),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Reorder Fields')
                .setDescription('Select a field, then use the arrows to move it up or down.')
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(pickSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const pickCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_reorder_pick',
        time: 60_000,
        max: 1,
    });

    pickCollector.on('collect', async pickInter => {
        try {
        await pickInter.deferUpdate();
        const sourceIdx = parseInt(pickInter.values[0], 10);

        const upBtn = new ButtonBuilder()
            .setCustomId('eb_reorder_up')
            .setLabel('Move Up')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('⬆️')
            .setDisabled(sourceIdx === 0);

        const downBtn = new ButtonBuilder()
            .setCustomId('eb_reorder_down')
            .setLabel('Move Down')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('⬇️')
            .setDisabled(sourceIdx === state.fields.length - 1);

        const cancelBtn = new ButtonBuilder()
            .setCustomId('eb_reorder_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary);

        await pickInter.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Move Field')
                    .setDescription(
                        `Moving **${state.fields[sourceIdx].name}** — currently at position **${sourceIdx + 1}** of **${state.fields.length}**.`,
                    )
                    .setColor(getColor('info')),
            ],
            components: [new ActionRowBuilder().addComponents(upBtn, downBtn, cancelBtn)],
            flags: MessageFlags.Ephemeral,
        });

        const dirCollector = rootInteraction.channel.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i =>
                i.user.id === selectInteraction.user.id &&
                ['eb_reorder_up', 'eb_reorder_down', 'eb_reorder_cancel'].includes(i.customId),
            time: 30_000,
            max: 1,
        });

        dirCollector.on('collect', async dirInter => {
            try {
                await dirInter.deferUpdate();
                if (dirInter.customId === 'eb_reorder_cancel') return;

                const targetIdx =
                    dirInter.customId === 'eb_reorder_up' ? sourceIdx - 1 : sourceIdx + 1;

                if (targetIdx < 0 || targetIdx >= state.fields.length) return;

                const temp              = state.fields[sourceIdx];
                state.fields[sourceIdx] = state.fields[targetIdx];
                state.fields[targetIdx] = temp;

                await refreshDashboard(rootInteraction, state);
            } catch (error) {
                logger.warn('Embed builder reorder interaction failed:', error.message);
            }
        });
        } catch (error) {
            logger.warn('Embed builder reorder pick interaction failed:', error.message);
        }
    });
}

/* ────────────────────────────────────────────────────────────────────────────
 *  COMPONENT HANDLERS (add / edit / remove / settings)
 * ──────────────────────────────────────────────────────────────────────────── */

function buildComponentModal(customId, title, item, guild) {
    const role = item?.roleId ? guild.roles.cache.get(item.roleId) : null;

    const labelInput = new TextInputBuilder()
        .setCustomId('comp_label')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(80)
        .setRequired(true)
        .setPlaceholder('Gamer');
    if (item?.label) labelInput.setValue(item.label);

    const emojiInput = new TextInputBuilder()
        .setCustomId('comp_emoji')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(64)
        .setRequired(false)
        .setPlaceholder('🎮  or  <:name:123456789012345678>');
    if (item?.emoji) emojiInput.setValue(item.emoji);

    const roleInput = new TextInputBuilder()
        .setCustomId('comp_role')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(false)
        .setPlaceholder('Role name, ID or @mention (blank = no role)');
    const roleValue = role?.name ?? item?.roleId;
    if (roleValue) roleInput.setValue(roleValue);

    const hiddenInput = new TextInputBuilder()
        .setCustomId('comp_hidden')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4000)
        .setRequired(false)
        .setPlaceholder('Only the clicker sees this. Vars: {user} {server} {role}');
    if (item?.hiddenMessage) hiddenInput.setValue(item.hiddenMessage);

    const behaviorRadio = new RadioGroupBuilder()
        .setCustomId('comp_behavior')
        .setRequired(false)
        .addOptions(
            BEHAVIORS.map(b => ({
                label: b.label,
                value: b.value,
                default: b.value === (item?.behavior ?? 'toggle'),
            })),
        );

    return new ModalBuilder()
        .setCustomId(customId)
        .setTitle(title)
        .addLabelComponents(
            new LabelBuilder().setLabel('Label (button / option text)').setTextInputComponent(labelInput),
            new LabelBuilder().setLabel('Emoji (optional)').setTextInputComponent(emojiInput),
            new LabelBuilder().setLabel('Role to give (optional)').setTextInputComponent(roleInput),
            new LabelBuilder().setLabel('Hidden message (optional)').setTextInputComponent(hiddenInput),
            new LabelBuilder().setLabel('Role behavior (if a role is set)').setRadioGroupComponent(behaviorRadio),
        );
}

/** Validates a submitted component modal. Returns { item } or { error }. */
async function parseComponentModal(submitted, guild, existing) {
    const label     = submitted.fields.getTextInputValue('comp_label').trim();
    const emojiRaw  = submitted.fields.getTextInputValue('comp_emoji').trim();
    const roleRaw   = submitted.fields.getTextInputValue('comp_role').trim();
    const hidden    = submitted.fields.getTextInputValue('comp_hidden').trim();
    let behavior    = submitted.fields.getRadioGroup('comp_behavior') ?? 'toggle';
    if (!BEHAVIORS.some(b => b.value === behavior)) behavior = 'toggle';

    if (!label) return { error: 'A component needs a label.' };

    let emoji = null;
    if (emojiRaw) {
        if (!parseEmoji(emojiRaw)) {
            return {
                error: `\`${emojiRaw}\` is not a valid emoji. Use a normal emoji like 🎮 or a custom one like \`<:name:123456789012345678>\`.`,
            };
        }
        emoji = emojiRaw;
    }

    let roleId = null;
    if (roleRaw) {
        const role = resolveRole(guild, roleRaw);
        if (!role) {
            return { error: `I couldn't find a role matching \`${roleRaw}\`. Use the exact role name, its ID, or an @mention.` };
        }

        // Only re-check permissions when the role is new or changed.
        if (role.id !== existing?.roleId) {
            const invoker =
                (await guild.members.fetch(submitted.user.id).catch(() => null)) ?? submitted.member;
            const problem = validateRoleForUse(role, invoker, guild);
            if (problem) return { error: problem };
        }
        roleId = role.id;
    }

    if (!roleId && !hidden) {
        return { error: 'Give the component a **role**, a **hidden message**, or both — otherwise clicking it would do nothing.' };
    }

    return {
        item: {
            id: existing?.id ?? generateId(3),
            label,
            emoji,
            roleId,
            behavior,
            hiddenMessage: hidden || null,
        },
    };
}

async function handleAddComponent(selectInteraction, rootInteraction, state) {
    if (state.components.length >= MAX_COMPONENTS) {
        await selectInteraction.deferUpdate();
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: `A panel can have a maximum of ${MAX_COMPONENTS} components.`,
        });
        return;
    }

    const guild = rootInteraction.guild;
    const modal = buildComponentModal('eb_add_component', 'Add Component', null, guild);

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'eb_add_component' && i.user.id === selectInteraction.user.id,
            time: 300_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const parsed = await parseComponentModal(submitted, guild, null);
    if (parsed.error) {
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: parsed.error });
        return;
    }

    state.components.push(parsed.item);

    await submitted.deferUpdate().catch(() => {});
    await refreshDashboard(rootInteraction, state);
}

async function handleEditComponent(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate();
    const guild = rootInteraction.guild;

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_edit_component_pick')
        .setPlaceholder('Select a component to edit...')
        .addOptions(
            state.components.slice(0, 25).map((c, i) => {
                const role = c.roleId ? guild.roles.cache.get(c.roleId) : null;
                const opt = new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${c.label.substring(0, 50)}`)
                    .setDescription(
                        `${role ? `@${role.name}`.substring(0, 50) : 'No role'} · ${c.hiddenMessage ? 'Has hidden message' : 'No hidden message'}`,
                    )
                    .setValue(String(i));
                const emoji = parseEmoji(c.emoji);
                opt.setEmoji(emoji ?? '🧩');
                return opt;
            }),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Edit Component')
                .setDescription('Select the component whose label, emoji, role or hidden message you want to change.')
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(pickSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const pickCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_edit_component_pick',
        time: 60_000,
        max: 1,
    });

    pickCollector.on('collect', async pickInter => {
        try {
            const idx  = parseInt(pickInter.values[0], 10);
            const item = state.components[idx];
            if (!item) { await pickInter.deferUpdate(); return; }

            const modal = buildComponentModal('eb_edit_component_modal', `Edit Component ${idx + 1}`, item, guild);

            const shown = await InteractionHelper.safeShowModal(pickInter, modal);
            if (!shown) return;

            const submitted = await pickInter
                .awaitModalSubmit({
                    filter: i =>
                        i.customId === 'eb_edit_component_modal' && i.user.id === pickInter.user.id,
                    time: 300_000,
                })
                .catch(() => null);

            if (!submitted) return;

            const parsed = await parseComponentModal(submitted, guild, item);
            if (parsed.error) {
                await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: parsed.error });
                return;
            }

            state.components[idx] = parsed.item;

            await submitted.deferUpdate().catch(() => {});
            await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder component edit interaction failed:', error.message);
        }
    });
}

async function handleRemoveComponent(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_remove_component_pick')
        .setPlaceholder('Select a component to remove...')
        .addOptions(
            state.components.slice(0, 25).map((c, i) => {
                const opt = new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${c.label.substring(0, 50)}`)
                    .setValue(String(i));
                opt.setEmoji(parseEmoji(c.emoji) ?? '✖️');
                return opt;
            }),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Remove Component')
                .setDescription('Select the component you want to delete.')
                .setColor(getColor('warning')),
        ],
        components: [new ActionRowBuilder().addComponents(pickSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const removeCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_remove_component_pick',
        time: 60_000,
        max: 1,
    });

    removeCollector.on('collect', async removeInter => {
        try {
            await removeInter.deferUpdate();
            const idx = parseInt(removeInter.values[0], 10);
            state.components.splice(idx, 1);
            await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder component removal interaction failed:', error.message);
        }
    });
}

function buildSettingsPayload(state) {
    const modeSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_cfg_mode')
        .setPlaceholder('Display mode')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Buttons')
                .setDescription('Up to 25 buttons, 5 per row')
                .setValue('buttons')
                .setEmoji('🔘')
                .setDefault(state.componentMode === 'buttons'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Dropdown menu')
                .setDescription('One select menu with up to 25 options')
                .setValue('select')
                .setEmoji('📂')
                .setDefault(state.componentMode === 'select'),
        );

    const styleSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_cfg_style')
        .setPlaceholder('Button color')
        .addOptions(
            Object.entries(BUTTON_STYLES).map(([key, s]) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(s.label)
                    .setDescription('Button color (buttons mode only)')
                    .setValue(key)
                    .setEmoji(s.emoji)
                    .setDefault(state.buttonStyle === key),
            ),
        );

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('eb_cfg_placeholder')
            .setLabel('Dropdown Placeholder')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('💬'),
        new ButtonBuilder()
            .setCustomId('eb_cfg_done')
            .setLabel('Done')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅'),
    );

    return {
        embeds: [
            new EmbedBuilder()
                .setTitle('Component Settings')
                .setDescription('Changes apply to the next **Post Embed** or **Update Posted**.')
                .addFields(
                    { name: 'Mode',         value: state.componentMode === 'select' ? 'Dropdown menu' : 'Buttons', inline: true },
                    { name: 'Button Color', value: BUTTON_STYLES[state.buttonStyle]?.label ?? 'Blurple',           inline: true },
                    { name: 'Placeholder',  value: state.componentPlaceholder ? `\`${state.componentPlaceholder}\`` : '`Default`', inline: true },
                )
                .setColor(getColor('info')),
        ],
        components: [
            new ActionRowBuilder().addComponents(modeSelect),
            new ActionRowBuilder().addComponents(styleSelect),
            buttonRow,
        ],
    };
}

async function handleComponentSettings(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate().catch(() => {});

    await selectInteraction.followUp({
        ...buildSettingsPayload(state),
        flags: MessageFlags.Ephemeral,
    });

    const collector = rootInteraction.channel.createMessageComponentCollector({
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId.startsWith('eb_cfg_'),
        time: 180_000,
    });

    collector.on('collect', async i => {
        try {
            if (i.customId === 'eb_cfg_mode') {
                state.componentMode = i.values[0] === 'select' ? 'select' : 'buttons';
                await i.update(buildSettingsPayload(state));
            } else if (i.customId === 'eb_cfg_style') {
                if (BUTTON_STYLES[i.values[0]]) state.buttonStyle = i.values[0];
                await i.update(buildSettingsPayload(state));
            } else if (i.customId === 'eb_cfg_placeholder') {
                const input = new TextInputBuilder()
                    .setCustomId('cfg_placeholder')
                    .setStyle(TextInputStyle.Short)
                    .setMaxLength(150)
                    .setRequired(false)
                    .setPlaceholder('Choose a role...');
                if (state.componentPlaceholder) input.setValue(state.componentPlaceholder);

                const modal = new ModalBuilder()
                    .setCustomId('eb_cfg_placeholder_modal')
                    .setTitle('Dropdown Placeholder')
                    .addLabelComponents(
                        new LabelBuilder()
                            .setLabel('Placeholder text (blank = default)')
                            .setTextInputComponent(input),
                    );

                const shown = await InteractionHelper.safeShowModal(i, modal);
                if (!shown) return;

                const submitted = await i
                    .awaitModalSubmit({
                        filter: m => m.customId === 'eb_cfg_placeholder_modal' && m.user.id === i.user.id,
                        time: 120_000,
                    })
                    .catch(() => null);
                if (!submitted) return;

                state.componentPlaceholder = submitted.fields.getTextInputValue('cfg_placeholder').trim() || null;

                if (submitted.isFromMessage?.()) await submitted.update(buildSettingsPayload(state));
                else await submitted.deferUpdate().catch(() => {});
            } else if (i.customId === 'eb_cfg_done') {
                await i.update({ content: '✅ Component settings saved.', embeds: [], components: [] });
                collector.stop('done');
            }

            await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder component settings interaction failed:', error.message);
        }
    });
}

/* ────────────────────────────────────────────────────────────────────────────
 *  POST / UPDATE
 * ──────────────────────────────────────────────────────────────────────────── */

async function handlePostEmbed(selectInteraction, rootInteraction, state, guild) {
    if (!hasEmbedContent(state)) {
        await selectInteraction.deferUpdate();
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: 'Add at least a title, description, or field before posting.',
        });
        return;
    }

    await selectInteraction.deferUpdate();

    const chanSelect = new ChannelSelectMenuBuilder()
        .setCustomId('eb_post_channel')
        .setPlaceholder('Select a channel...')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Post Embed')
                .setDescription(
                    state.components.length > 0
                        ? `Select the channel where this embed will be sent, with its **${state.components.length}** component(s).`
                        : 'Select the channel where this embed will be sent.',
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(chanSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const chanCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_post_channel',
        time: 60_000,
        max: 1,
    });

    chanCollector.on('collect', async chanInter => {
        try {
            await chanInter.deferUpdate();
            const channel = chanInter.channels.first();

            if (!channel) {
                await replyUserError(chanInter, {
                    type: ErrorTypes.USER_INPUT,
                    message: 'Could not resolve the selected channel.',
                });
                return;
            }

            const perms = channel.permissionsFor(guild.members.me);
            if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
                await replyUserError(chanInter, {
                    type: ErrorTypes.PERMISSION,
                    message: `I need **View Channel**, **Send Messages** and **Embed Links** permissions in ${channel} to post there.`,
                });
                return;
            }

            const hasComponents = state.components.length > 0;
            const panelId = hasComponents ? generateId(4) : null;
            const rows = hasComponents ? buildComponentRows(panelId, state, guild) : [];

            const sent = await channel.send({ embeds: [buildFinalEmbed(state)], components: rows });

            if (hasComponents) {
                await savePanel(
                    panelId,
                    makePanelRecord(state, {
                        guildId:   guild.id,
                        channelId: channel.id,
                        messageId: sent.id,
                        createdBy: chanInter.user.id,
                    }),
                );
                registerEmbedComponentHandler(chanInter.client);
            }

            state.lastPosted = { panelId, channelId: channel.id, messageId: sent.id };

            await chanInter.followUp({
                embeds: [
                    successEmbed(
                        'Embed Sent',
                        `Your embed has been posted to ${channel}.${hasComponents ? '\nUse **Update Posted** later to change its content, roles or hidden messages.' : ''}`,
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });

            await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.error('Embed builder post failed:', error);
            await replyUserError(chanInter, {
                type: ErrorTypes.UNKNOWN,
                message: `Failed to post the embed: ${error.message}`,
            }).catch(() => {});
        }
    });
}

async function handleUpdatePosted(selectInteraction, rootInteraction, state, guild) {
    await selectInteraction.deferUpdate();

    const last = state.lastPosted;
    if (!last) {
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: 'You have not posted anything from this builder session yet.',
        });
        return;
    }

    if (!hasEmbedContent(state)) {
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: 'Add at least a title, description, or field before updating.',
        });
        return;
    }

    const channel = await guild.channels.fetch(last.channelId).catch(() => null);
    const message = channel?.messages ? await channel.messages.fetch(last.messageId).catch(() => null) : null;

    if (!message) {
        state.lastPosted = null;
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: 'I could not find the posted message — it was probably deleted. Use **Post Embed** to send it again.',
        });
        await refreshDashboard(rootInteraction, state);
        return;
    }

    try {
        const hasComponents = state.components.length > 0;
        const panelId = hasComponents ? (last.panelId ?? generateId(4)) : null;
        const rows = hasComponents ? buildComponentRows(panelId, state, guild) : [];

        await message.edit({ embeds: [buildFinalEmbed(state)], components: rows });

        if (hasComponents) {
            await savePanel(
                panelId,
                makePanelRecord(state, {
                    guildId:   guild.id,
                    channelId: channel.id,
                    messageId: message.id,
                    createdBy: selectInteraction.user.id,
                }),
            );
            registerEmbedComponentHandler(selectInteraction.client);
        } else if (last.panelId) {
            await deletePanel(last.panelId);
        }

        state.lastPosted = { panelId, channelId: channel.id, messageId: message.id };

        await selectInteraction.followUp({
            embeds: [successEmbed('Panel Updated', `The message in ${channel} has been updated.\n[Jump to message](${message.url})`)],
            flags: MessageFlags.Ephemeral,
        });
        await refreshDashboard(rootInteraction, state);
    } catch (error) {
        logger.error('Embed builder update failed:', error);
        await replyUserError(selectInteraction, {
            type: ErrorTypes.UNKNOWN,
            message: `Failed to update the posted message: ${error.message}`,
        }).catch(() => {});
    }
}

async function handleJsonExport(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate();

    const previewEmbed = buildPreviewEmbed(state);
    const json = JSON.stringify(previewEmbed.toJSON(), null, 2);

    if (json.length <= 3980) {
        await selectInteraction.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Embed JSON')
                    .setDescription(`\`\`\`json\n${json}\n\`\`\``)
                    .setColor(getColor('info')),
            ],
            flags: MessageFlags.Ephemeral,
        });
    } else {
        await selectInteraction.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Embed JSON')
                    .setDescription('The JSON is too long to display inline — see the attached file.')
                    .setColor(getColor('info')),
            ],
            files: [
                {
                    attachment: Buffer.from(json, 'utf-8'),
                    name: 'embed.json',
                },
            ],
            flags: MessageFlags.Ephemeral,
        });
    }
}

/* ────────────────────────────────────────────────────────────────────────────
 *  COMMAND
 * ──────────────────────────────────────────────────────────────────────────── */

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('embedbuilder')
        .setDescription('Build and post a custom embed with live preview, buttons/dropdown self-roles and hidden messages')
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        try {
            const deferSuccess = await InteractionHelper.safeDefer(interaction, {
                flags: MessageFlags.Ephemeral,
            });
            if (!deferSuccess) return;

            // Make sure posted panels respond to clicks (no-op if already registered).
            registerEmbedComponentHandler(interaction.client);

            const guild = interaction.guild;
            const state = createInitialState();

            await refreshDashboard(interaction, state);

            const collector = interaction.channel.createMessageComponentCollector({
                componentType: ComponentType.Button,
                filter: i =>
                    i.user.id === interaction.user.id && i.customId.startsWith('eb_main_'),
                idle: IDLE_TIMEOUT,
            });

            collector.on('collect', async ci => {
                try {
                    switch (ci.customId) {
                        case 'eb_main_edit_content':
                            await handleEditContent(ci, interaction, state);
                            break;
                        case 'eb_main_set_color':
                            await handleSetColor(ci, interaction, state);
                            break;
                        case 'eb_main_set_images':
                            await handleSetImages(ci, interaction, state);
                            break;
                        case 'eb_main_set_author':
                            await handleSetAuthor(ci, interaction, state);
                            break;
                        case 'eb_main_set_footer':
                            await handleSetFooter(ci, interaction, state);
                            break;
                        case 'eb_main_post_embed':
                            await handlePostEmbed(ci, interaction, state, guild);
                            break;
                        case 'eb_main_update_posted':
                            await handleUpdatePosted(ci, interaction, state, guild);
                            break;
                        case 'eb_main_add_field':
                            await handleAddField(ci, interaction, state);
                            break;
                        case 'eb_main_edit_field':
                            await handleEditField(ci, interaction, state);
                            break;
                        case 'eb_main_remove_field':
                            await handleRemoveField(ci, interaction, state);
                            break;
                        case 'eb_main_reorder_fields':
                            await handleReorderFields(ci, interaction, state);
                            break;
                        case 'eb_main_add_component':
                            await handleAddComponent(ci, interaction, state);
                            break;
                        case 'eb_main_edit_component':
                            await handleEditComponent(ci, interaction, state);
                            break;
                        case 'eb_main_remove_component':
                            await handleRemoveComponent(ci, interaction, state);
                            break;
                        case 'eb_main_component_settings':
                            await handleComponentSettings(ci, interaction, state);
                            break;
                        case 'eb_main_toggle_timestamp':
                            state.timestamp = !state.timestamp;
                            await ci.deferUpdate();
                            await refreshDashboard(interaction, state);
                            break;
                        case 'eb_main_json_export':
                            await handleJsonExport(ci, interaction, state);
                            break;
                        case 'eb_main_reset_all':
                            Object.assign(state, createInitialState());
                            await ci.deferUpdate();
                            await refreshDashboard(interaction, state);
                            break;
                        default:
                            await ci.deferUpdate();
                    }
                } catch (error) {
                    logger.error('Error in embedbuilder collector:', error);
                    const msg =
                        error instanceof TitanBotError
                            ? error.userMessage || 'An error occurred.'
                            : 'An unexpected error occurred.';
                    if (!ci.replied && !ci.deferred) await ci.deferUpdate().catch(() => {});
                    await replyUserError(ci, {
                        type: ErrorTypes.UNKNOWN,
                        message: msg,
                    }).catch(() => {});
                }
            });

            collector.on('end', async (_, reason) => {
                if (reason === 'idle' || reason === 'time') {
                    await InteractionHelper.safeEditReply(interaction, { components: [] }).catch(() => {});
                }
            });
        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in embedbuilder:', error);
            throw new TitanBotError(
                `embedbuilder failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                'Failed to open the embed builder.',
            );
        }
    },
};
