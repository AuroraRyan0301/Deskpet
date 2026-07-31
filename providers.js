// Provider adapters for the slow loop. DOM-free and pure: each turns the prompt plus
// one frame into a request body, and pulls the reply text back out of a response.
//
//   openai     — /v1/chat/completions (GPT_API_free, sub2api, vLLM, Ollama…).
//                JSON is *asked for* in the prompt; the model may ignore it.
//   anthropic  — /v1/messages. `output_config.format` enforces the schema and the
//                action is an enum built from the pack, so a malformed reply or an
//                invented action is not representable.
//
// Neither api.anthropic.com nor sub2api sends CORS headers, so requests go through the
// local server's /_llm forwarder rather than straight from the page.

export const PROVIDERS = ['openai', 'anthropic'];

export const PROVIDER_PRESETS = {
  openai: {
    endpoint: 'https://api.chatanywhere.tech/v1/chat/completions',
    model: 'gpt-4o-mini',
    // GPT_API_free: 100/day on gpt-4o-mini, but only 5/day on gpt-4o and the gpt-5
    // series. Changing model without changing this makes the guard lie.
    dailyQuota: 100,
  },
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-opus-5',
    dailyQuota: 500,
  },
  sub2api: {
    provider: 'anthropic',
    endpoint: 'http://127.0.0.1:8080/v1/messages',
    model: 'claude-opus-5',
    // The user's own gateway with their own balance — a client-side daily cap here
    // protects nothing and once muted the pet mid-day. Effectively unlimited; the guard
    // still exists as runaway protection (a bug looping the slow path hits it eventually).
    dailyQuota: 9999999,
  },
};

export function splitDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUrl ?? ''));
  return m ? { mediaType: m[1], data: m[2] } : null;
}

// The enum is what makes a hallucinated action impossible rather than merely filtered.
export function replySchema() {
  // One field: the verb script. The action enum this used to enforce is now enforced by
  // the total parser in script.js, which also validates coordinates, durations and
  // capabilities — things a JSON schema cannot express anyway. 600 mirrors
  // SCRIPT_LIMITS.maxScriptChars.
  return {
    type: 'object',
    properties: {
      script: { type: 'string', maxLength: 600 },
    },
    required: ['script'],
    additionalProperties: false,
  };
}

export const ADAPTERS = {
  openai: {
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    body: ({ prompt, imageDataUrl, model, maxTokens }) => {
      const content = [{ type: 'text', text: prompt.user }];
      if (imageDataUrl) content.push({ type: 'image_url', image_url: { url: imageDataUrl, detail: 'low' } });
      return {
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content },
        ],
      };
    },
    text: (data) => data?.choices?.[0]?.message?.content ?? '',
    error: (data) => data?.error?.message ?? data?.message ?? null,
  },

  anthropic: {
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    body: ({ prompt, imageDataUrl, model, maxTokens, vocabulary, maxLineChars }) => {
      const content = [{ type: 'text', text: prompt.user }];
      const img = splitDataUrl(imageDataUrl);
      if (img) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      }
      return {
        model,
        max_tokens: maxTokens,
        // Top-level field on this API, not a message with role "system".
        system: prompt.system,
        messages: [{ role: 'user', content }],
        output_config: {
          format: { type: 'json_schema', schema: replySchema() },
        },
      };
    },
    text: (data) => {
      const blocks = Array.isArray(data?.content) ? data.content : [];
      return blocks.find((b) => b?.type === 'text')?.text ?? '';
    },
    error: (data) => data?.error?.message ?? data?.message ?? null,
  },
};

export const adapterFor = (provider) => ADAPTERS[provider] ?? ADAPTERS.openai;
