import { NextResponse } from "next/server";

type Verdict = "supported" | "hallucination" | "uncertain";

type JudgeResult = {
  judge: "fact-check" | "roast";
  verdict: Verdict;
  title: string;
  summary: string;
  detail?: string;
  confidence?: number;
  oneLiner?: string;
  longComment?: string;
  styleSignature?: string;
};

type ReviewCardResult = {
  id: string;
  personaName: string;
  modelName: string;
  avatarUrl: string;
  modelId: string;
  usedModel: string;
  verdict: Verdict;
  oneLiner: string;
  longComment: string;
  confidence?: number;
  styleSignature?: string;
};

type AuditPayload = {
  text?: string;
};

type ProviderResult = {
  verdict?: Verdict;
  title?: string;
  summary?: string;
  detail?: string;
  confidence?: number;
  one_liner?: string;
  long_comment?: string;
  style_signature?: string;
};

type ParsedJudgeContent = {
  verdict: Verdict;
  title: string;
  summary: string;
  detail?: string;
  confidence?: number;
  oneLiner?: string;
  longComment?: string;
  styleSignature?: string;
};

type OpenRouterChoice = {
  message?: {
    content?: string;
  };
};

type OpenRouterResponse = {
  choices?: OpenRouterChoice[];
};

type ModelInfo = {
  reviewers: Record<string, string>;
};

type CacheRecord = {
  createdAt: number;
  modelInfo: ModelInfo;
  reviews: ReviewCardResult[];
};

type JudgeFallbackOutcome = {
  usedModel: string;
  result: JudgeResult;
};

type RoastStyleProfile = {
  toneDirectives: string[];
  dictionDirectives: string[];
  structureDirectives: string[];
  signaturePhrases: string[];
  forbiddenPhrases: string[];
};

type RoastPromptContext = {
  model: string;
  text: string;
};

type ReviewModelConfig = {
  id: string;
  personaName: string;
  modelName: string;
  avatarUrl: string;
  modelId: string;
};

const auditCache = new Map<string, CacheRecord>();
const CACHE_TTL_MS = 1000 * 60 * 10;
const DEFAULT_API_BASE_URL = "https://crazyrouter.com/v1";

const REVIEW_MODEL_CONFIGS: ReviewModelConfig[] = [
  {
    id: "opus",
    personaName: "不愿留下姓名的 Opus",
    modelName: "Claude Opus",
    avatarUrl: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/claude-ai-light.png",
    modelId: process.env.REVIEW_MODEL_OPUS ?? "claude-sonnet-4",
  },
  {
    id: "gpt",
    personaName: "只给结论的 GPT 法官",
    modelName: "GPT",
    avatarUrl: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/openai-light.png",
    modelId: process.env.REVIEW_MODEL_GPT ?? "gpt-4o-mini",
  },
  {
    id: "gemini",
    personaName: "礼貌但不松口的 Gemini",
    modelName: "Gemini",
    avatarUrl: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/google-gemini.png",
    modelId: process.env.REVIEW_MODEL_GEMINI ?? "gemini-2.5-flash",
  },
  {
    id: "deepseek",
    personaName: "嘴很硬的 DeepSeek",
    modelName: "DeepSeek",
    avatarUrl: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/deepseek.png",
    modelId: process.env.REVIEW_MODEL_DEEPSEEK ?? "deepseek-v3",
  },
];

const EMPTY_STYLE_PROFILE: RoastStyleProfile = {
  toneDirectives: [],
  dictionDirectives: [],
  structureDirectives: [],
  signaturePhrases: [],
  forbiddenPhrases: [],
};

// 结构预留：后续可以按模型名补充口癖与风格约束。
const ROAST_STYLE_PROFILES: Partial<Record<string, RoastStyleProfile>> = {};

export async function POST(request: Request) {
  let payload: AuditPayload;

  try {
    payload = (await request.json()) as AuditPayload;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const text = payload.text?.trim();

  if (!text) {
    return NextResponse.json({ error: "请先输入一段待审文本。" }, { status: 400 });
  }

  const cached = auditCache.get(text);
  const isFresh = cached && Date.now() - cached.createdAt < CACHE_TTL_MS;

  if (isFresh) {
    return NextResponse.json({
      text,
      cached: true,
      modelInfo: cached.modelInfo,
      reviews: cached.reviews,
    });
  }

  const apiKey = process.env.CRAZYROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
  const apiBaseUrl = (
    process.env.CRAZYROUTER_BASE_URL ??
    process.env.LLM_API_BASE_URL ??
    process.env.OPENROUTER_BASE_URL ??
    DEFAULT_API_BASE_URL
  ).replace(/\/$/, "");

  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "缺少 CRAZYROUTER_API_KEY（或 OPENROUTER_API_KEY）。先在 .env.local 里配置 Key，再重新发起审判。",
      },
      { status: 500 },
    );
  }

  try {
    const reviewOutcomes = await Promise.all(
      REVIEW_MODEL_CONFIGS.map((reviewConfig) =>
        buildReviewCard({
          apiKey,
          apiBaseUrl,
          text,
          reviewConfig,
        }),
      ),
    );

    const reviewers = reviewOutcomes.reduce<Record<string, string>>((acc, item) => {
      acc[item.id] = item.usedModel;
      return acc;
    }, {});

    const modelInfo: ModelInfo = { reviewers };

    auditCache.set(text, {
      createdAt: Date.now(),
      modelInfo,
      reviews: reviewOutcomes,
    });

    return NextResponse.json({
      text,
      cached: false,
      modelInfo,
      reviews: reviewOutcomes,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "模型调用失败，请稍后再试。",
      },
      { status: 500 },
    );
  }
}

async function buildReviewCard({
  apiKey,
  apiBaseUrl,
  text,
  reviewConfig,
}: {
  apiKey: string;
  apiBaseUrl: string;
  text: string;
  reviewConfig: ReviewModelConfig;
}): Promise<ReviewCardResult> {
  try {
    const outcome = await requestJudgeWithFallback({
      apiKey,
      apiBaseUrl,
      models: [reviewConfig.modelId],
      judge: "roast",
      input: text,
      getSystemPrompt: (model) =>
        buildRoastPrompt({
          model,
          text,
        }),
    });

    const oneLiner = normalizeTextForCard(
      outcome.result.oneLiner?.trim() || outcome.result.summary?.trim(),
      "观点有冲击力，但证据位还需要补。",
      32,
    );
    const longComment = normalizeTextForCard(
      outcome.result.longComment?.trim() || outcome.result.detail?.trim(),
      "该模型本轮未给出稳定判词，先看其他法官意见。",
      220,
    );

    return {
      ...reviewConfig,
      usedModel: outcome.usedModel,
      verdict: outcome.result.verdict,
      oneLiner,
      longComment,
      confidence: outcome.result.confidence,
      styleSignature: outcome.result.styleSignature,
    };
  } catch {
    return {
      ...reviewConfig,
      usedModel: reviewConfig.modelId,
      verdict: "uncertain",
      oneLiner: "该模型暂时离线，未能返回判词。",
      longComment: "当前通道繁忙，请稍后再试，或先参考其他模型结论。",
    };
  }
}

async function requestJudge({
  apiKey,
  apiBaseUrl,
  model,
  judge,
  input,
  systemPrompt,
}: {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  judge: JudgeResult["judge"];
  input: string;
  systemPrompt: string;
}): Promise<JudgeResult> {
  const response = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(process.env.LLM_SITE_URL
        ? { "HTTP-Referer": process.env.LLM_SITE_URL }
        : process.env.OPENROUTER_SITE_URL
          ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL }
          : {}),
      ...(process.env.LLM_APP_NAME
        ? { "X-Title": process.env.LLM_APP_NAME }
        : process.env.OPENROUTER_APP_NAME
          ? { "X-Title": process.env.OPENROUTER_APP_NAME }
          : {}),
    },
    body: JSON.stringify({
      model,
      temperature: judge === "roast" ? 0.9 : 0.2,
      response_format: {
        type: "json_object",
      },
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: input,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`模型 ${model} 调用失败：${errorText}`);
  }

  const payload = (await response.json()) as OpenRouterResponse;
  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(`模型 ${model} 没有返回可解析内容。`);
  }

  return {
    judge,
    ...parseJudgeResponse(content, judge),
  };
}

async function requestJudgeWithFallback({
  apiKey,
  apiBaseUrl,
  models,
  judge,
  input,
  systemPrompt,
  getSystemPrompt,
}: {
  apiKey: string;
  apiBaseUrl: string;
  models: string[];
  judge: JudgeResult["judge"];
  input: string;
  systemPrompt?: string;
  getSystemPrompt?: (model: string) => string;
}): Promise<JudgeFallbackOutcome> {
  const dedupedModels = Array.from(new Set(models.map((item) => item.trim()).filter(Boolean)));
  const failures: string[] = [];

  for (const model of dedupedModels) {
    try {
      const prompt = getSystemPrompt ? getSystemPrompt(model) : systemPrompt;
      if (!prompt) {
        throw new Error(`模型 ${model} 缺少 system prompt。`);
      }

      const result = await requestJudge({
        apiKey,
        apiBaseUrl,
        model,
        judge,
        input,
        systemPrompt: prompt,
      });
      return {
        usedModel: model,
        result,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `模型 ${model} 调用失败（未知错误）`;
      failures.push(message);
    }
  }

  throw new Error(`所有候选模型都调用失败：${failures.join(" | ") || "无可用错误详情"}`);
}

function parseJudgeResponse(content: string, judge: JudgeResult["judge"]): ParsedJudgeContent {
  try {
    const parsed = safeParseProviderResult(content);
    const oneLiner = parsed.one_liner?.trim() || parsed.summary?.trim() || fallbackSummary(judge);
    const longComment = parsed.long_comment?.trim() || parsed.detail?.trim() || undefined;
    const summary = judge === "roast" ? oneLiner : parsed.summary?.trim() || fallbackSummary(judge);
    const detail = judge === "roast" ? longComment : parsed.detail?.trim() || undefined;

    return {
      verdict: normalizeVerdict(parsed.verdict),
      title: parsed.title?.trim() || fallbackTitle(judge),
      summary,
      detail,
      confidence: normalizeConfidence(parsed.confidence),
      oneLiner,
      longComment,
      styleSignature: parsed.style_signature?.trim() || undefined,
    };
  } catch {
    return {
      verdict: "uncertain",
      title: fallbackTitle(judge),
      summary: content.trim() || fallbackSummary(judge),
      oneLiner: content.trim() || fallbackSummary(judge),
    };
  }
}

function safeParseProviderResult(content: string): ProviderResult {
  try {
    return JSON.parse(content) as ProviderResult;
  } catch {
    const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
      return JSON.parse(fencedMatch[1]) as ProviderResult;
    }

    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = content.slice(firstBrace, lastBrace + 1);
      return JSON.parse(candidate) as ProviderResult;
    }

    throw new Error("No JSON object found in model response.");
  }
}

function normalizeVerdict(verdict?: string): Verdict {
  if (verdict === "supported" || verdict === "hallucination" || verdict === "uncertain") {
    return verdict;
  }

  return "uncertain";
}

function normalizeConfidence(confidence?: number): number | undefined {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return undefined;
  }

  return Math.max(0, Math.min(1, confidence));
}

function fallbackTitle(judge: JudgeResult["judge"]) {
  return judge === "fact-check" ? "事实审判结果" : "一句话锐评";
}

function fallbackSummary(judge: JudgeResult["judge"]) {
  return judge === "fact-check" ? "模型没有返回结构化判词。" : "模型没有返回锐评。";
}

function buildRoastPrompt(context: RoastPromptContext) {
  const styleProfile = resolveRoastStyleProfile(context.model);

  return [
    "你是一个能做事实判断并输出风格化评论的 AI 法官。",
    "你需要独立判断原文是否存在事实问题，并给出自己的立场。",
    "只输出 JSON，不要输出 Markdown。",
    `【原文】${context.text}`,
    "【风格约束-语气】" + formatDirectiveBlock(styleProfile.toneDirectives),
    "【风格约束-措辞】" + formatDirectiveBlock(styleProfile.dictionDirectives),
    "【风格约束-结构】" + formatDirectiveBlock(styleProfile.structureDirectives),
    "【风格约束-口癖】" + formatDirectiveBlock(styleProfile.signaturePhrases),
    "【风格约束-禁用词】" + formatDirectiveBlock(styleProfile.forbiddenPhrases),
    'JSON 结构为 {"verdict":"supported|hallucination|uncertain","title":"短标题","one_liner":"一句话锐评","long_comment":"一段判词","style_signature":"可选，说明采用了哪类风格","confidence":0到1之间的小数}。',
    "one_liner 保持 12-24 字，long_comment 保持 80-140 字。",
    "如果 verdict=supported，请使用克制且略带傲慢的认可口吻；如果为 hallucination 或 uncertain，可以带锋芒但避免人身攻击。",
  ].join(" ");
}

function resolveRoastStyleProfile(model: string): RoastStyleProfile {
  const normalized = model.toLowerCase();

  for (const [key, profile] of Object.entries(ROAST_STYLE_PROFILES)) {
    if (!profile) {
      continue;
    }
    if (normalized.includes(key.toLowerCase())) {
      return profile;
    }
  }

  return EMPTY_STYLE_PROFILE;
}

function formatDirectiveBlock(directives: string[]) {
  if (directives.length === 0) {
    return "（待配置）";
  }

  return directives.map((directive) => `- ${directive}`).join(" ");
}

function normalizeTextForCard(raw: string | undefined, fallback: string, maxLength: number) {
  if (!raw) {
    return fallback;
  }

  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) {
    return fallback;
  }

  // 避免把服务报错、请求 ID 或超长无空格串直接展示到卡片里。
  if (/request id|model_not_found|service temporarily unavailable|^\{.*"error"/i.test(text)) {
    return fallback;
  }
  if (/[A-Za-z0-9_:\-./]{70,}/.test(text)) {
    return fallback;
  }

  if (text.length > maxLength) {
    return `${text.slice(0, maxLength - 1)}…`;
  }

  return text;
}
