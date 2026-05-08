import { fetchChat } from "./ChatAPI";
import { fetchMessage, fetchMessageSets } from "./MessageAPI";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { Message, MessagePart, MessageSetDetail } from "../ChatState";

interface ExportMessage {
    id: string;
    model: string;
    content: string;
    timestamp: string;
    replies?: Turn[];
}

interface Turn {
    level: number;
    user?: ExportMessage;
    responses: ExportMessage[];
}

interface ExportData {
    exportType: "chat" | "message-thread";
    chatId: string;
    title: string;
    createdAt: string;
    exportedAt: string;
    sourceMessageId?: string;
    sourceModel?: string;
    turns: Turn[];
}

function formatToolUse(part: MessagePart): string[] {
    const lines: string[] = [];

    for (const toolCall of part.toolCalls ?? []) {
        lines.push(`(tool use: ${toolCall.namespacedToolName})`);
    }

    for (const toolResult of part.toolResults ?? []) {
        const toolName = toolResult.namespacedToolName
            ? `: ${toolResult.namespacedToolName}`
            : "";
        lines.push(`(tool result${toolName})`);
    }

    return lines;
}

function formatMessagePart(part: MessagePart): string {
    return [part.content.trim(), ...formatToolUse(part)]
        .filter(Boolean)
        .join("\n");
}

function messageContent(message: Message): string {
    const partsContent = message.parts
        .slice()
        .sort((a, b) => a.level - b.level)
        .map(formatMessagePart)
        .filter(Boolean)
        .join("\n\n");
    return partsContent || message.text || "";
}

function toExportMessage(message: Message): ExportMessage {
    return {
        id: message.id,
        model: message.model,
        content: messageContent(message),
        timestamp: "",
    };
}

function exportableResponses(
    messageSet: MessageSetDetail,
    responseMode: "all" | "selected",
): Message[] {
    const toolsMessages = messageSet.toolsBlock.chatMessages;
    if (toolsMessages.length > 0) {
        return toolsMessages
            .filter((message) =>
                responseMode === "selected" ? message.selected : true,
            )
            .sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    }

    const legacyMessages = [
        messageSet.chatBlock.message,
        ...messageSet.compareBlock.messages,
        messageSet.compareBlock.synthesis,
        ...messageSet.brainstormBlock.ideaMessages,
    ].filter((message): message is Message => Boolean(message));

    return legacyMessages
        .filter((message) =>
            responseMode === "selected" ? message.selected : true,
        )
        .sort(
            (a, b) =>
                (a.level ?? 0) - (b.level ?? 0) ||
                a.model.localeCompare(b.model),
        );
}

function messagesInSet(messageSet: MessageSetDetail): Message[] {
    return [
        messageSet.userBlock.message,
        ...messageSet.toolsBlock.chatMessages,
        messageSet.chatBlock.message,
        ...messageSet.chatBlock.reviews,
        ...messageSet.compareBlock.messages,
        messageSet.compareBlock.synthesis,
        ...messageSet.brainstormBlock.ideaMessages,
    ].filter((message): message is Message => Boolean(message));
}

function hasNonCopiedMessages(messageSet: MessageSetDetail): boolean {
    return messagesInSet(messageSet).some((message) => !message.branchedFromId);
}

async function attachReplies(
    response: ExportMessage,
    source: Message,
): Promise<ExportMessage> {
    if (!source.replyChatId) return response;

    const replies = await buildReplyTurns(source.replyChatId);
    return replies.length > 0 ? { ...response, replies } : response;
}

async function buildTurnsFromMessageSets(
    messageSets: MessageSetDetail[],
    options: {
        includeReplies: boolean;
        responseMode: "all" | "selected";
    },
): Promise<Turn[]> {
    const sortedSets = messageSets
        .slice()
        .sort(
            (a, b) =>
                a.level - b.level || a.createdAt.localeCompare(b.createdAt),
        );
    const turns: Turn[] = [];

    for (let index = 0; index < sortedSets.length; index++) {
        const messageSet = sortedSets[index];

        if (messageSet.type === "user") {
            const nextSet = sortedSets[index + 1];
            const turn: Turn = {
                level: messageSet.level,
                user: messageSet.userBlock.message
                    ? {
                          ...toExportMessage(messageSet.userBlock.message),
                          timestamp: messageSet.createdAt,
                      }
                    : undefined,
                responses: [],
            };

            if (
                nextSet?.type === "ai" &&
                nextSet.level === messageSet.level + 1
            ) {
                const responses = exportableResponses(
                    nextSet,
                    options.responseMode,
                );
                turn.responses = await Promise.all(
                    responses.map(async (message) => {
                        const response = {
                            ...toExportMessage(message),
                            timestamp: nextSet.createdAt,
                        };
                        return options.includeReplies
                            ? attachReplies(response, message)
                            : response;
                    }),
                );
                index++;
            }

            turns.push(turn);
            continue;
        }

        const responses = exportableResponses(messageSet, options.responseMode);
        turns.push({
            level: messageSet.level,
            responses: await Promise.all(
                responses.map(async (message) => {
                    const response = {
                        ...toExportMessage(message),
                        timestamp: messageSet.createdAt,
                    };
                    return options.includeReplies
                        ? attachReplies(response, message)
                        : response;
                }),
            ),
        });
    }

    return turns.filter((turn) => turn.user || turn.responses.length > 0);
}

async function buildReplyTurns(replyChatId: string): Promise<Turn[]> {
    const [chat, messageSets] = await Promise.all([
        fetchChat(replyChatId),
        fetchMessageSets(replyChatId),
    ]);
    const chatCreatedAt = new Date(chat.createdAt).getTime();
    const replyMessageSets = messageSets.filter(
        (messageSet) =>
            hasNonCopiedMessages(messageSet) &&
            new Date(messageSet.createdAt).getTime() >= chatCreatedAt,
    );

    return buildTurnsFromMessageSets(replyMessageSets, {
        includeReplies: false,
        responseMode: "selected",
    });
}

async function fetchChatExportData(chatId: string): Promise<ExportData> {
    const chat = await fetchChat(chatId);
    const messageSets = await fetchMessageSets(chatId);
    const turns = await buildTurnsFromMessageSets(messageSets, {
        includeReplies: true,
        responseMode: "all",
    });

    return {
        exportType: "chat",
        chatId: chat.id,
        title: chat.title || "Untitled Chat",
        createdAt: chat.createdAt,
        exportedAt: new Date().toISOString(),
        turns,
    };
}

async function fetchMessageThreadExportData(
    messageId: string,
): Promise<ExportData> {
    const sourceMessage = await fetchMessage(messageId);
    if (!sourceMessage) {
        throw new Error(`Message not found: ${messageId}`);
    }

    const [chat, messageSets] = await Promise.all([
        fetchChat(sourceMessage.chatId),
        fetchMessageSets(sourceMessage.chatId),
    ]);
    const responseSet = messageSets.find(
        (messageSet) => messageSet.id === sourceMessage.messageSetId,
    );
    if (!responseSet) {
        throw new Error(`Message set not found: ${sourceMessage.messageSetId}`);
    }

    const userSet = messageSets.find(
        (messageSet) =>
            messageSet.type === "user" &&
            messageSet.level === responseSet.level - 1,
    );

    const sourceMessageWithParts =
        exportableResponses(responseSet, "all").find(
            (message) => message.id === messageId,
        ) ?? sourceMessage;
    const response = await attachReplies(
        {
            ...toExportMessage(sourceMessageWithParts),
            timestamp: responseSet.createdAt,
        },
        sourceMessageWithParts,
    );

    return {
        exportType: "message-thread",
        chatId: chat.id,
        title: `${chat.title || "Untitled Chat"} - ${sourceMessage.model}`,
        createdAt: chat.createdAt,
        exportedAt: new Date().toISOString(),
        sourceMessageId: sourceMessage.id,
        sourceModel: sourceMessage.model,
        turns: [
            {
                level: userSet?.level ?? responseSet.level,
                user: userSet?.userBlock.message
                    ? {
                          ...toExportMessage(userSet.userBlock.message),
                          timestamp: userSet.createdAt,
                      }
                    : undefined,
                responses: [response],
            },
        ],
    };
}

// Reserved names on Windows that would fail to open even with an extension.
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function sanitizeFilename(name: string): string {
    let cleaned = name
        // Strip path separators and characters illegal on Windows / problematic on macOS
        .replace(/[/\\:*?"<>|]/g, "_")
        // Strip control characters (NUL, BEL, etc.) that some filesystems reject
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trim()
        // Trailing dots and spaces are stripped on Windows; trim them ourselves
        .replace(/[. ]+$/g, "");
    if (cleaned.length === 0) return "chat";
    if (WINDOWS_RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
    // Cap at 200 chars to leave room for the extension within typical 255-char
    // filename limits on macOS/ext4/NTFS.
    return cleaned.slice(0, 200);
}

// Escape a string for use as plain text inside a markdown heading.
// Strips markdown-active leading characters (#, line breaks).
function escapeMarkdownInline(s: string): string {
    return s.replace(/[\r\n]+/g, " ").replace(/^#+/, (m) => "\\" + m);
}

// Escape lines in message content that would otherwise alter the surrounding
// document structure: horizontal rules (---, ___, ***), ATX headings (#..),
// fenced code block markers (``` and ~~~), and our own turn separator.
// Also escape leading `<` so renderers that allow raw HTML cannot interpret
// content as an HTML tag.
function escapeMarkdownContent(content: string): string {
    return content
        .split("\n")
        .map((line) => {
            if (/^(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) return "\\" + line;
            if (/^#{1,6}(\s|$)/.test(line)) return "\\" + line;
            if (/^(?:```|~~~)/.test(line)) return "\\" + line;
            if (/^</.test(line)) return "\\" + line;
            return line;
        })
        .join("\n");
}

function formatAsJSON(data: ExportData): string {
    return JSON.stringify(data, null, 2);
}

function formatAsMarkdown(data: ExportData): string {
    let md = `# ${escapeMarkdownInline(data.title || "Untitled Chat")}\n`;
    // ISO date so exports are deterministic across users/locales.
    md += `Created: ${new Date(data.createdAt).toISOString().slice(0, 10)}\n\n`;
    md += `Export: ${data.exportType === "chat" ? "Full chat" : "Model thread"}\n\n`;
    md += `---\n\n`;

    data.turns.forEach((turn, index) => {
        md += `## Turn ${index + 1}\n\n`;
        if (turn.user?.content) {
            md += `### You\n${escapeMarkdownContent(turn.user.content)}\n\n`;
        }

        for (const response of turn.responses) {
            md += `### ${escapeMarkdownInline(response.model)}\n${escapeMarkdownContent(response.content)}\n\n`;
            if (response.replies && response.replies.length > 0) {
                md += `#### Replies\n\n`;
                response.replies.forEach((replyTurn, replyIndex) => {
                    md += `##### Reply ${replyIndex + 1}\n\n`;
                    if (replyTurn.user?.content) {
                        md += `###### You\n${escapeMarkdownContent(replyTurn.user.content)}\n\n`;
                    }
                    for (const replyResponse of replyTurn.responses) {
                        md += `###### ${escapeMarkdownInline(replyResponse.model)}\n${escapeMarkdownContent(replyResponse.content)}\n\n`;
                    }
                });
            }
        }

        md += `---\n\n`;
    });

    return md;
}

async function exportChat(
    data: ExportData,
    extension: "json" | "md",
    formatName: string,
    formatter: (data: ExportData) => string,
): Promise<boolean> {
    const content = formatter(data);

    const filePath = await save({
        defaultPath: `${sanitizeFilename(data.title)}.${extension}`,
        filters: [{ name: formatName, extensions: [extension] }],
    });

    if (!filePath) return false;
    await writeTextFile(filePath, content);
    return true;
}

export function exportChatAsJSON(chatId: string): Promise<boolean> {
    return fetchChatExportData(chatId).then((data) =>
        exportChat(data, "json", "JSON", formatAsJSON),
    );
}

export function exportChatAsMarkdown(chatId: string): Promise<boolean> {
    return fetchChatExportData(chatId).then((data) =>
        exportChat(data, "md", "Markdown", formatAsMarkdown),
    );
}

export function exportMessageThreadAsJSON(messageId: string): Promise<boolean> {
    return fetchMessageThreadExportData(messageId).then((data) =>
        exportChat(data, "json", "JSON", formatAsJSON),
    );
}

export function exportMessageThreadAsMarkdown(
    messageId: string,
): Promise<boolean> {
    return fetchMessageThreadExportData(messageId).then((data) =>
        exportChat(data, "md", "Markdown", formatAsMarkdown),
    );
}
