'use strict';

const OpenAI = require('openai');
const { HttpsProxyAgent } = require('https-proxy-agent');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProxyAgent() {
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  if (proxyUrl) {
    try {
      return new HttpsProxyAgent(proxyUrl);
    } catch (err) {
      console.error(`[配置] 代理 URL 无效，将跳过代理: ${err.message}`);
    }
  }
  return undefined;
}

const proxyAgent = getProxyAgent();
const clientCache = new Map();

function getProviders(customDefaultModel = '') {
  const providers = [];

  const explicitBaseUrl = (process.env.BASE_URL || '').trim();
  const explicitKey = (process.env.AUTH_TOKEN || '').trim();
  const explicitModel = (process.env.MODEL || customDefaultModel || '').trim();

  const geminiKey = (process.env.GEMINI_API_KEY || (explicitBaseUrl.includes('google') ? explicitKey : '')).trim();
  const geminiBaseUrl = (explicitBaseUrl.includes('google') ? explicitBaseUrl : 'https://generativelanguage.googleapis.com/v1beta/openai/').trim();

  const geminiModels = [
    explicitModel && (explicitModel.startsWith('gemini') || explicitModel.includes('flash') || explicitModel.includes('pro')) ? explicitModel : null,
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-2.5-pro',
  ].filter((m, i, arr) => m && arr.indexOf(m) === i);

  if (geminiKey) {
    providers.push({
      name: 'Gemini',
      apiKey: geminiKey,
      baseURL: geminiBaseUrl,
      models: geminiModels,
    });
  }

  const deepseekKey = (process.env.DEEPSEEK_API_KEY || (explicitBaseUrl.includes('deepseek') ? explicitKey : '')).trim();
  const deepseekBaseUrl = (explicitBaseUrl.includes('deepseek') ? explicitBaseUrl : 'https://api.deepseek.com').trim();

  const deepseekModels = [
    explicitModel && explicitModel.includes('deepseek') ? explicitModel : null,
    'deepseek-chat',
  ].filter((m, i, arr) => m && arr.indexOf(m) === i);

  if (deepseekKey) {
    providers.push({
      name: 'DeepSeek',
      apiKey: deepseekKey,
      baseURL: deepseekBaseUrl,
      models: deepseekModels,
    });
  }

  if (providers.length === 0 && explicitKey) {
    providers.push({
      name: 'Custom',
      apiKey: explicitKey,
      baseURL: explicitBaseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai/',
      models: [explicitModel || 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'].filter(Boolean),
    });
  }

  return providers;
}

function getClientForProvider(provider) {
  const cacheKey = `${provider.name}:${provider.baseURL}:${provider.apiKey}`;
  if (!clientCache.has(cacheKey)) {
    const options = {
      apiKey: provider.apiKey,
      baseURL: provider.baseURL,
      timeout: 180000,
      maxRetries: 1,
      defaultHeaders: {
        'Accept-Encoding': 'identity',
      },
    };
    if (proxyAgent) {
      options.httpAgent = proxyAgent;
    }
    clientCache.set(cacheKey, new OpenAI(options));
  }
  return clientCache.get(cacheKey);
}

async function callChatCompletion(params, { defaultModel = '' } = {}) {
  const providers = getProviders(defaultModel);
  if (providers.length === 0) {
    throw new Error('未配置任何可用的 LLM API Key (请设置 GEMINI_API_KEY, DEEPSEEK_API_KEY 或 AUTH_TOKEN)');
  }

  let lastError;
  for (const provider of providers) {
    const client = getClientForProvider(provider);
    for (const modelName of provider.models) {
      try {
        console.log(`[LLM] 尝试调用 ${provider.name} (模型: ${modelName})...`);
        const result = await client.chat.completions.create({
          ...params,
          model: modelName,
        });
        return result;
      } catch (err) {
        lastError = err;
        const status = Number(err?.status || err?.statusCode || 0);
        const errMsg = err?.message || String(err);
        console.warn(`[LLM] ${provider.name} (${modelName}) 调用失败 [状态码: ${status || 'N/A'}]: ${errMsg}`);
        await wait(2000);
      }
    }
  }
  throw lastError;
}

module.exports = {
  callChatCompletion,
  getProviders,
  proxyAgent,
  wait,
};
