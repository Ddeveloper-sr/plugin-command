/*
 * Member Check
 *
 * Kettu / Revenge plugin
 *
 * This plugin performs a LOCAL audit of member information already
 * available to the Discord client.
 *
 * It does not send moderation data to an external server.
 */

import { registerCommand } from "@lib/api/commands";
import { findByProps } from "@webpack";
import { logger } from "@lib/utils/logger";

const PLUGIN_NAME = "MemberCheck";

const log = new logger(PLUGIN_NAME);

/*
 * ---------------------------------------------------------
 * Types
 * ---------------------------------------------------------
 */

interface User {
    id: string;
    username?: string;
    globalName?: string | null;
}

interface GuildMember {
    user?: User;
    nick?: string | null;
}

interface UserProfile {
    bio?: string | null;
    pronouns?: string | null;
}

interface CustomStatus {
    state?: string | null;
}

interface AuditTarget {
    id: string;
    username: string;
    displayName: string;
    nickname: string;
    bio: string;
    status: string;
}

interface Finding {
    member: AuditTarget;
    category: "SLUR" | "INAPPROPRIATE";
    location: "USERNAME" | "DISPLAY NAME" | "NICKNAME" | "BIO" | "STATUS";
    term: string;
}

/*
 * ---------------------------------------------------------
 * Configuration
 * ---------------------------------------------------------
 *
 * Keep these lists configurable.
 *
 * Do NOT put explicit slurs into the source code if this
 * plugin is going to be distributed publicly.
 *
 * The defaults below intentionally contain placeholders.
 */

const SLUR_TERMS = [
    "example-slur-1",
    "example-slur-2"
];

const INAPPROPRIATE_TERMS = [
    "example-inappropriate-1",
    "example-inappropriate-2"
];

/*
 * ---------------------------------------------------------
 * Discord stores
 * ---------------------------------------------------------
 */

const UserStore = findByProps("getUser");

const GuildMemberStore = findByProps(
    "getMember",
    "getMembers"
);

const UserProfileStore = findByProps(
    "getUserProfile"
);

const PresenceStore = findByProps(
    "getStatus",
    "getStatuses"
);

/*
 * ---------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------
 */

function normalize(value: string | null | undefined): string {
    return (value ?? "")
        .normalize("NFKC")
        .toLowerCase()
        .trim();
}

function containsTerm(
    value: string,
    terms: string[]
): string | null {
    const normalized = normalize(value);

    if (!normalized) {
        return null;
    }

    for (const term of terms) {
        const normalizedTerm = normalize(term);

        if (
            normalizedTerm.length > 0 &&
            normalized.includes(normalizedTerm)
        ) {
            return term;
        }
    }

    return null;
}

function getUserProfile(
    userId: string
): UserProfile | null {
    try {
        return (
            UserProfileStore?.getUserProfile?.(userId) ??
            UserProfileStore?.getProfile?.(userId) ??
            null
        );
    } catch {
        return null;
    }
}

function getCustomStatus(
    userId: string
): string {
    try {
        const status = PresenceStore?.getStatus?.(userId);

        if (typeof status === "string") {
            return status;
        }

        if (status?.state) {
            return status.state;
        }

        return "";
    } catch {
        return "";
    }
}

/*
 * ---------------------------------------------------------
 * Member collection
 * ---------------------------------------------------------
 */

function getGuildMembers(
    guildId: string
): GuildMember[] {
    try {
        const members =
            GuildMemberStore?.getMembers?.(guildId);

        if (Array.isArray(members)) {
            return members;
        }

        return [];
    } catch (error) {
        log.error("Unable to retrieve guild members", error);
        return [];
    }
}

/*
 * ---------------------------------------------------------
 * Audit
 * ---------------------------------------------------------
 */

function auditMember(
    member: GuildMember
): Finding[] {
    const user = member.user;

    if (!user?.id) {
        return [];
    }

    const username = user.username ?? "";
    const displayName =
        user.globalName ??
        username;

    const nickname =
        member.nick ?? "";

    const profile =
        getUserProfile(user.id);

    const bio =
        profile?.bio ?? "";

    const status =
        getCustomStatus(user.id);

    const target: AuditTarget = {
        id: user.id,
        username,
        displayName,
        nickname,
        bio,
        status
    };

    const fields: Array<{
        value: string;
        location: Finding["location"];
    }> = [
        {
            value: username,
            location: "USERNAME"
        },
        {
            value: displayName,
            location: "DISPLAY NAME"
        },
        {
            value: nickname,
            location: "NICKNAME"
        },
        {
            value: bio,
            location: "BIO"
        },
        {
            value: status,
            location: "STATUS"
        }
    ];

    const findings: Finding[] = [];

    for (const field of fields) {
        const slur = containsTerm(
            field.value,
            SLUR_TERMS
        );

        if (slur) {
            findings.push({
                member: target,
                category: "SLUR",
                location: field.location,
                term: slur
            });

            continue;
        }

        const inappropriate =
            containsTerm(
                field.value,
                INAPPROPRIATE_TERMS
            );

        if (inappropriate) {
            findings.push({
                member: target,
                category: "INAPPROPRIATE",
                location: field.location,
                term: inappropriate
            });
        }
    }

    return findings;
}

/*
 * ---------------------------------------------------------
 * Formatting
 * ---------------------------------------------------------
 */

function formatFinding(
    finding: Finding
): string {
    const member =
        finding.member.displayName ||
        finding.member.username;

    return [
        `**${member}**`,
        `> Category: \`${finding.category}\``,
        `> Location: \`${finding.location}\``
    ].join("\n");
}

function buildReport(
    scanned: number,
    findings: Finding[]
): string {
    const header = [
        "**Member Check**",
        "",
        `Scanned: \`${scanned}\``,
        `Flagged: \`${findings.length}\``,
        ""
    ].join("\n");

    if (findings.length === 0) {
        return [
            header,
            "No matching profile text was found.",
            "",
            "_Only you can see this result._"
        ].join("\n");
    }

    /*
     * Discord messages have practical length limits.
     * Keep the local result compact.
     */

    const MAX_FINDINGS = 25;

    const visible =
        findings.slice(0, MAX_FINDINGS);

    const body = visible
        .map(formatFinding)
        .join("\n\n");

    const remaining =
        findings.length - visible.length;

    return [
        header,
        body,
        remaining > 0
            ? `\n…and ${remaining} more finding(s).`
            : "",
        "",
        "_Only you can see this result._"
    ].join("\n");
}

/*
 * ---------------------------------------------------------
 * Command
 * ---------------------------------------------------------
 *
 * This creates:
 *
 * /check members
 *
 * The nested command is represented using the Revenge
 * command API's command registration system.
 */

const disposeCommand = registerCommand(
    {
        name: "check",
        description:
            "Check locally available member profile information.",

        options: [
            {
                type: 1,
                name: "members",
                description:
                    "Audit visible members for configured terms.",
                options: []
            }
        ],

        execute: async (
            args: unknown,
            ctx: {
                channel: {
                    id: string;
                };
            }
        ) => {
            /*
             * We intentionally don't perform the audit if the
             * current channel isn't associated with a guild.
             */

            const channelId =
                ctx?.channel?.id;

            if (!channelId) {
                return;
            }

            /*
             * Obtain the current guild from Discord's stores.
             */

            const ChannelStore =
                findByProps("getChannel");

            const channel =
                ChannelStore?.getChannel?.(
                    channelId
                );

            const guildId =
                channel?.guild_id;

            if (!guildId) {
                sendPrivateResult(
                    channelId,
                    "This command can only be used inside a server."
                );

                return;
            }

            const members =
                getGuildMembers(guildId);

            if (members.length === 0) {
                sendPrivateResult(
                    channelId,
                    [
                        "**Member Check**",
                        "",
                        "No locally available members were found.",
                        "",
                        "_Only you can see this result._"
                    ].join("\n")
                );

                return;
            }

            /*
             * Audit locally.
             */

            const findings =
                members.flatMap(
                    auditMember
                );

            const report =
                buildReport(
                    members.length,
                    findings
                );

            sendPrivateResult(
                channelId,
                report
            );
        }
    },

    PLUGIN_NAME
);

/*
 * ---------------------------------------------------------
 * Private/local response
 * ---------------------------------------------------------
 */

function sendPrivateResult(
    channelId: string,
    content: string
): void {
    /*
     * Revenge/Vencord-style client command APIs expose
     * sendBotMessage for local command responses.
     *
     * If your installed Kettu build does not export this
     * function, replace this function with the equivalent
     * local message/UI API from your Kettu version.
     */

    try {
        const commandsApi =
            window.bunny?.api?.commands;

        if (
            typeof commandsApi?.sendBotMessage ===
            "function"
        ) {
            commandsApi.sendBotMessage(
                channelId,
                {
                    content
                }
            );

            return;
        }

        /*
         * Fallback: don't send a real Discord message.
         *
         * This prevents accidentally exposing the audit
         * results to everyone in the channel.
         */

        log.info(
            "Member Check result:",
            content
        );
    } catch (error) {
        log.error(
            "Failed to display Member Check result",
            error
        );
    }
}

/*
 * ---------------------------------------------------------
 * Cleanup
 * ---------------------------------------------------------
 */

export default {
    name: PLUGIN_NAME,

    start() {
        log.info(
            "Member Check enabled"
        );
    },

    stop() {
        try {
            if (typeof disposeCommand === "function") {
                disposeCommand();
            }
        } catch (error) {
            log.error(
                "Failed to unregister command",
                error
            );
        }

        log.info(
            "Member Check disabled"
        );
    }
};