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

async function fetchChatMessages(chatId: string): Promise<MessageRow[]> {
    const messages = await db.select<MessageRow[]>(
        `SELECT
            m.id as message_id,
            ms.level / 2 as turn_index,
            m.model,
            CASE
                WHEN m.model = 'user' THEN COALESCE(m.text, '')
                ELSE COALESCE(NULLIF(m.text, ''), (
                    SELECT GROUP_CONCAT(content, '')
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
          AND m.block_type = ms.selected_block_type
        ORDER BY ms.level ASC, m.created_at ASC`,
        [chatId],
    );
    return messages;
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
        title: chat.title,
        createdAt: chat.createdAt,
        turns,
    };
}

function formatAsJSON(data: ExportData): string {
    return JSON.stringify(data, null, 2);
}

function formatAsMarkdown(data: ExportData): string {
    let md = `# ${data.title}\n`;
    md += `Created: ${new Date(data.createdAt).toLocaleDateString()}\n\n`;
    md += `---\n\n`;

    for (const turn of data.turns) {
        // User message
        if (turn.user.content) {
            md += `### You\n${turn.user.content}\n\n`;
        }

        // AI responses
        for (const response of turn.responses) {
            md += `### ${response.model}\n${response.content}\n\n`;
        }

        md += `---\n\n`;
    }

    return md;
}

export async function exportChatAsJSON(chatId: string): Promise<boolean> {
    const data = await fetchExportData(chatId);
    const jsonContent = formatAsJSON(data);

    const filePath = await save({
        defaultPath: `${data.title || "chat"}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (!filePath) return false;
    await writeTextFile(filePath, jsonContent);
    return true;
}

export async function exportChatAsMarkdown(chatId: string): Promise<boolean> {
    const data = await fetchExportData(chatId);
    const mdContent = formatAsMarkdown(data);

    const filePath = await save({
        defaultPath: `${data.title || "chat"}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
    });

    if (!filePath) return false;
    await writeTextFile(filePath, mdContent);
    return true;
}
