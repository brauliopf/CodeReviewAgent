import { ChatCompletionCreateParamsNonStreaming } from "groq-sdk/resources/chat/completions";
import { groq, GROQ_MODEL } from "./groq";

/**
 * Generate a chat completion
 * Parameter: options - an object that contains parameters for the chat completion request. The Omit utility type excludes the "model" property from the ChatCompletionCreateParamsNonStreaming type.
 * @param options - Omit<ChatCompletionCreateParamsNonStreaming, "model">
 * @returns the chat completion
 */
export const generateChatCompletion = async (
  options: Omit<ChatCompletionCreateParamsNonStreaming, "model">
) => {
  const response = await groq.chat.completions.create({
    model: GROQ_MODEL,
    temperature: 0,
    ...options,
  });
  return response.choices[0].message;
};
