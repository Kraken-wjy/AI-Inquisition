import { NextResponse } from "next/server";

type Verdict = "supported" | "hallucination" | "uncertain";

type JudgeResult = {
  judge: "fact-check" | "roast";
  verdict: Verdict;
  title: string;
  summary: string;
  detail?: string;
  confidence?: number;
};

type AuditPayload = {
  text?: string;
};

type ProviderResult = {
  verdict: Verdict;
  title: string;
  summary: string;
  detail?: string;
  confidence?: number;
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
  factCheck: string;
  roast: string;
};

type CacheRecord = {
  createdAt: number;
  modelInfo: ModelInfo;
  results: JudgeResult[];
};

type JudgeFallbackOutcome = {
  usedModel: string;
  result: JudgeResult;
};

const auditCache = new Map<string, CacheRecord>();
const CACHE_TTL_MS = 1000 * 60 * 10;
const DEFAULT_API_BASE_URL = "https://crazyrouter.com/v1";

const FACT_CHECK_MODEL =
  process.env.FACT_CHECK_MODEL ?? process.env.OPENROUTER_MODEL_FACT_CHECK ?? "gpt-4o-mini";
const ROAST_MODEL =
  process.env.ROAST_MODEL ?? process.env.OPENROUTER_MODEL_ROAST ?? "claude-sonnet-4";
const FACT_CHECK_FALLBACK_MODELS = parseFallbackModels(
  process.env.FACT_CHECK_FALLBACK_MODELS,
  ["gemini-2.5-flash", "deepseek-v3", "gpt-4o-mini"],
);
const ROAST_FALLBACK_MODELS = parseFallbackModels(
  process.env.ROAST_FALLBACK_MODELS,
  ["deepseek-v3", "gemini-2.5-flash", "gpt-4o-mini"],
);

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
      results: cached.results,
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
    const [factCheckOutcome, roastOutcome] = await Promise.all([
      requestJudgeWithFallback({
        apiKey,
        apiBaseUrl,
        models: [FACT_CHECK_MODEL, ...FACT_CHECK_FALLBACK_MODELS],
        judge: "fact-check",
        input: text,
        systemPrompt: [
          "你是一个严谨的 AI 事实核查法官。",
          "判断用户输入是否包含事实性错误、张冠李戴、伪造引用或明显不可靠的断言。",
          "你必须输出 JSON，不要输出 Markdown。",
          'JSON 结构为 {"verdict":"supported|hallucination|uncertain","title":"短标题","summary":"一句简洁判词","detail":"可选，补充原因","confidence":0到1之间的小数}。',
          "summary 保持 50 字以内，detail 保持 80 字以内。",
        ].join(" "),
      }),
      requestJudgeWithFallback({
        apiKey,
        apiBaseUrl,
        models: [ROAST_MODEL, ...ROAST_FALLBACK_MODELS],
        judge: "roast",
        input: text,
        systemPrompt: [
          "你是一个冷静但带锋芒的赛博评论员。",
          "请根据用户输入写一句一针见血的锐评。",
          "如果原文疑似有错，就优雅地讽刺；如果暂未发现错误，就用高傲但克制的口吻表示勉强过关。",
          "你必须输出 JSON，不要输出 Markdown。",
          'JSON 结构为 {"verdict":"supported|hallucination|uncertain","title":"短标题","summary":"一句锐评","detail":"可选","confidence":0到1之间的小数}。',
          "summary 保持 28 字以内。",
        ].join(" "),
      }),
    ]);

    const modelInfo: ModelInfo = {
      factCheck: factCheckOutcome.usedModel,
      roast: roastOutcome.usedModel,
    };
    const results: JudgeResult[] = [factCheckOutcome.result, roastOutcome.result];

    auditCache.set(text, {
      createdAt: Date.now(),
      modelInfo,
      results,
    });

    return NextResponse.json({
      text,
      cached: false,
      modelInfo,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "模型调用失败，请稍后再试。",
      },
      { status: 500 },
    );
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
}: {
  apiKey: string;
  apiBaseUrl: string;
  models: string[];
  judge: JudgeResult["judge"];
  input: string;
  systemPrompt: string;
}): Promise<JudgeFallbackOutcome> {
  const dedupedModels = Array.from(new Set(models.map((item) => item.trim()).filter(Boolean)));
  const failures: string[] = [];

  for (const model of dedupedModels) {
    try {
      const result = await requestJudge({
        apiKey,
        apiBaseUrl,
        model,
        judge,
        input,
        systemPrompt,
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

  throw new Error(
    `所有候选模型都调用失败：${failures.join(" | ") || "无可用错误详情"}`,
  );
}

function parseJudgeResponse(content: string, judge: JudgeResult["judge"]): ProviderResult {
  try {
    const parsed = safeParseProviderResult(content);

    return {
      verdict: normalizeVerdict(parsed.verdict),
      title: parsed.title?.trim() || fallbackTitle(judge),
      summary: parsed.summary?.trim() || fallbackSummary(judge),
      detail: parsed.detail?.trim() || undefined,
      confidence: normalizeConfidence(parsed.confidence),
    };
  } catch {
    return {
      verdict: "uncertain",
      title: fallbackTitle(judge),
      summary: content.trim() || fallbackSummary(judge),
    };
  }
}

function safeParseProviderResult(content: string): Partial<ProviderResult> {
  try {
    return JSON.parse(content) as Partial<ProviderResult>;
  } catch {
    const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
      return JSON.parse(fencedMatch[1]) as Partial<ProviderResult>;
    }

    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = content.slice(firstBrace, lastBrace + 1);
      return JSON.parse(candidate) as Partial<ProviderResult>;
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

function parseFallbackModels(value: string | undefined, defaults: string[]) {
  if (!value) {
    return defaults;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : defaults;
}
