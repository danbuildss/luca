import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { buildSystemPrompt } from './system.js';
import { loadConversationHistory, saveMessage } from './context.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { assertUserScoped } from './guardrails.js';

const MAX_STEPS = 6;
const AGENT_MODEL = process.env.AGENT_MODEL ?? 'gpt-4o';

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
    _openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return _openai;
}

export async function runAgent(params: {
  userId: string;
  userMessage: string;
}): Promise<string> {
  const { userId, userMessage } = params;

  assertUserScoped(userId);

  const [systemPrompt, history] = await Promise.all([
    buildSystemPrompt(userId),
    loadConversationHistory(userId),
  ]);

  await saveMessage({ userId, role: 'user', content: userMessage });

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const openai = getOpenAI();
  let steps = 0;

  while (steps < MAX_STEPS) {
    steps++;

    const response = await openai.chat.completions.create({
      model: AGENT_MODEL,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
    });

    const choice = response.choices[0];
    if (!choice) throw new Error('No response from model');

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // No tool calls — we have the final answer
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const reply = assistantMessage.content ?? '';
      await saveMessage({ userId, role: 'assistant', content: reply });
      return reply;
    }

    // Execute each tool call
    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      let toolArgs: Record<string, unknown>;

      try {
        toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        toolArgs = {};
      }

      logger.debug({ userId, toolName, toolArgs }, 'agent tool call');

      let result: unknown;
      try {
        result = await executeTool(userId, toolName, toolArgs);
      } catch (err) {
        logger.error({ err, userId, toolName }, 'Tool execution error');
        result = { error: err instanceof Error ? err.message : 'Tool execution failed' };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Exceeded MAX_STEPS — ask model to wrap up with what it has
  logger.warn({ userId, steps }, 'Agent reached max steps, forcing final answer');
  const finalResponse = await openai.chat.completions.create({
    model: AGENT_MODEL,
    messages: [
      ...messages,
      {
        role: 'user',
        content: "Please give your best answer based on what you've gathered so far.",
      },
    ],
    tools: TOOL_DEFINITIONS,
    tool_choice: 'none',
  });

  const finalReply = finalResponse.choices[0]?.message.content ?? "I wasn't able to complete that. Please try again.";
  await saveMessage({ userId, role: 'assistant', content: finalReply });
  return finalReply;
}
