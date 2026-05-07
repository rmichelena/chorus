import { db } from "../DB";
import { fetchChat } from "./ChatAPI";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

interface MessageRow {
    message_id: string;
    turn_index: number;
    model: string;
    text: string;
    created_at: string;
}

interface Turn {
    user: {
        content: string;
        timestamp: string;
    };
    responses: Array<{
        model: string;
        content: string;
        timestamp: string;
    }>;
}

interface ExportData {
    chatId: string;
    title: string;
    createdAt: string;
    turns: Turn[];
}

// NOTE: the GROUP_CONCAT runs as a correlated subquery per non-user row.
// Acceptable cost for a manual, user-triggered export — revisit if export
// becomes batch/automatic.
async function fetchChatMessages(chatId: string): Promise<MessageRow[]> {
    const baseQuery = (extraFilter: string) => `
        SELECT
            m.id as message_id,
            ms.level / 2 as turn_index,
            m.model,
            CASE
                WHEN m.model = 'user' THEN COALESCE(m.text, '')
                ELSE COALESCE(NULLIF(m.text, ''), (
                    SELECT GROUP_CONCAT(content, char(10) || char(10))
                    FROM (
                        SELECT content FROM message_parts
                        WHERE message_id = m.id AND chat_id = m.chat_id
                        ORDER BY level
                    )
                ), '')
            END as text,
            m.created_at
        FROM messages m
        JOIN message_sets ms ON m.message_set_id = ms.id
        WHERE m.chat_id = ?
          AND m.selected = 1
          AND (m.is_review = 0 OR m.is_review IS NULL)
          ${extraFilter}
        ORDER BY ms.level ASC, m.created_at ASC`;

    const strict = await db.select<MessageRow[]>(
        baseQuery(`AND (
            ms.selected_block_type IS NULL
            OR m.block_type IS NULL
            OR m.block_type = ms.selected_block_type
        )`),
        [chatId],
    );
    if (strict.length > 0) return strict;

    // Fallback: older chats may have selected_block_type values that don't
    // match any message's block_type. Drop the block_type filter so the
    // export isn't silently empty.
    const relaxed = await db.select<MessageRow[]>(baseQuery(""), [chatId]);
    if (relaxed.length > 0) {
        console.warn(
            `Export: block_type filter excluded all messages for chat ${chatId}; falling back to relaxed query`,
        );
    }
    return relaxed;
}

function groupMessagesByTurns(messages: MessageRow[]): Turn[] {
    const turnMap = new Map<number, Turn>();

    for (const message of messages) {
        if (!turnMap.has(message.turn_index)) {
            turnMap.set(message.turn_index, {
                user: { content: "", timestamp: "" },
                responses: [],
            });
        }

        const turn = turnMap.get(message.turn_index)!;

        if (message.model === "user") {
            if (turn.user.content) {
                console.warn(
                    `Export: multiple user messages for turn ${message.turn_index}; keeping the latest`,
                );
            }
            turn.user = {
                content: message.text,
                timestamp: message.created_at,
            };
        } else {
            turn.responses.push({
                model: message.model,
                content: message.text,
                timestamp: message.created_at,
            });
        }
    }

    return Array.from(turnMap.values());
}

async function fetchExportData(chatId: string): Promise<ExportData> {
    const chat = await fetchChat(chatId);
    const messages = await fetchChatMessages(chatId);
    const turns = groupMessagesByTurns(messages);

    return {
        chatId: chat.id,
        title: chat.title || "Untitled Chat",
        createdAt: chat.createdAt,
        turns,
    };
}

// Reserved names on Windows that would fail to open even with an extension.
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function sanitizeFilename(name: string): string {
    let cleaned = name
        // Strip path separators and characters illegal on Windows / problematic on macOS
        .replace(/[/\\:*?"<>|]/g, "_")
        // Strip control characters (NUL, BEL, etc.) that some filesystems reject
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
    md += `---\n\n`;

    for (const turn of data.turns) {
        if (turn.user.content) {
            md += `### You\n${escapeMarkdownContent(turn.user.content)}\n\n`;
        }

        for (const response of turn.responses) {
            md += `### ${escapeMarkdownInline(response.model)}\n${escapeMarkdownContent(response.content)}\n\n`;
        }

        md += `---\n\n`;
    }

    return md;
}

async function exportChat(
    chatId: string,
    extension: "json" | "md",
    formatName: string,
    formatter: (data: ExportData) => string,
): Promise<boolean> {
    const data = await fetchExportData(chatId);
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
    return exportChat(chatId, "json", "JSON", formatAsJSON);
}

export function exportChatAsMarkdown(chatId: string): Promise<boolean> {
    return exportChat(chatId, "md", "Markdown", formatAsMarkdown);
}
