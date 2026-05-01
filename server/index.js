const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const ANTHROPIC_VERSION = "2023-06-01";
const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODELS = [
  process.env.ANTHROPIC_MODEL,
  "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-latest"
].filter(Boolean);

const getEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in environment.`);
  }
  return value;
};

const extractJson = (text) => {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    return null;
  }
};

const toTextBlock = (text) => [{ type: "text", text }];

const toImageBlock = (dataUrl) => {
  if (!dataUrl) return [];
  const match = dataUrl.match(/^data:(.+);base64,(.*)$/);
  if (!match) return [];
  return [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: match[1],
        data: match[2]
      }
    }
  ];
};

const callAnthropic = async ({ system, messages, maxTokens = 512 }) => {
  const apiKey = getEnv("ANTHROPIC_API_KEY");
  if (!DEFAULT_MODELS.length) {
    throw new Error("Missing ANTHROPIC_MODEL in environment.");
  }

  let lastError = "";

  for (let i = 0; i < DEFAULT_MODELS.length; i += 1) {
    const model = DEFAULT_MODELS[i];

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages
      })
    });

    if (response.ok) {
      return response.json();
    }

    const errText = await response.text();
    lastError = `Anthropic error (model ${model}): ${errText}`;
    const canRetryWithAnotherModel =
      response.status === 404 || errText.includes("not_found_error");

    if (!canRetryWithAnotherModel || i === DEFAULT_MODELS.length - 1) {
      throw new Error(lastError);
    }
  }

  throw new Error(lastError || "Anthropic request failed.");
};

app.post("/api/analyze", async (req, res) => {
  try {
    const { type, csvText, textContent, dataUrl, lang, skipTransactions } = req.body;
    const languageHint = lang === "ar" ? "Respond in Arabic." : "Respond in English.";

    let content = [];
    const keysPrompt = skipTransactions
      ? "keys insights_en (array), insights_ar (array), warnings_en (array), warnings_ar (array)"
      : "keys insights_en (array), insights_ar (array), warnings_en (array), warnings_ar (array), and transactions (array of objects with 'date' (YYYY-MM-DD), 'desc' (string), and 'amount' (number, positive for income, negative for expense))";

    if (type === "csv" && csvText) {
      content = toTextBlock(`Analyze this CSV data and return JSON with ${keysPrompt}.\n\n${csvText}`);
    } else if (type === "pdf" && textContent) {
      content = toTextBlock(`Analyze this PDF text and return JSON with ${keysPrompt}.\n\n${textContent}`);
    } else if (type === "image" && dataUrl) {
      content = [
        ...toTextBlock(`Analyze this invoice image and return JSON with ${keysPrompt}.`),
        ...toImageBlock(dataUrl)
      ];
    }

    if (!content.length) {
      return res.status(400).json({ error: "Invalid payload." });
    }

    const systemKeys = skipTransactions ? "insights_en, insights_ar, warnings_en, warnings_ar" : "insights_en, insights_ar, warnings_en, warnings_ar, and transactions";

    const data = await callAnthropic({
      system: `You are a financial analyst. You must provide insights and warnings in BOTH English and Arabic. Return JSON only with exactly these keys: ${systemKeys}.`,
      messages: [{ role: "user", content }],
      maxTokens: 2048
    });

    const text = (data.content || []).map(item => item.text).join("\n");
    const parsed = extractJson(text) || { insights_en: [], insights_ar: [], warnings_en: [], warnings_ar: [], transactions: [] };
    return res.json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { messages, context, lang } = req.body;
    const languageHint = lang === "ar" ? "Respond in Arabic." : "Respond in English.";
    const ctxText = typeof context === "string" ? context : JSON.stringify(context || {});

    const converted = (messages || []).map((msg) => ({
      role: msg.role,
      content: toTextBlock(msg.content)
    }));

    const data = await callAnthropic({
      system: `You are Udeer, an expert financial copilot. ${languageHint} Use the app context to answer accurately. App context: ${ctxText}`,
      messages: converted,
      maxTokens: 600
    });

    const reply = (data.content || []).map(item => item.text).join("\n");
    return res.json({ reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/nl", async (req, res) => {
  try {
    const { text, lang } = req.body;
    const languageHint = lang === "ar" ? "Respond in Arabic." : "Respond in English.";

    const data = await callAnthropic({
      system: `You extract transactions from natural language. ${languageHint} Return JSON only with key: transactions (array). Each transaction needs date (strictly YYYY-MM-DD. If today or not specified, use ${new Date().toISOString().slice(0, 10)}), desc, amount (positive income, negative expense).`,
      messages: [{ role: "user", content: toTextBlock(text || "") }],
      maxTokens: 300
    });

    const reply = (data.content || []).map(item => item.text).join("\n");
    const parsed = extractJson(reply) || { transactions: [] };
    return res.json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Udeer backend running on http://localhost:${port}`);
});
