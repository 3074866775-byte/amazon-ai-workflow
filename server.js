const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = 3456;

// 确保上传目录存在
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, uniqueSuffix + path.extname(file.originalname));
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 禁用HTML缓存，确保前端总是最新版本
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ==================== 工具函数 ====================

/** 模拟浏览器请求头，降低被 Amazon 反爬的概率 */
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="130", "Google Chrome";v="130"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * 从 HTML 中提取 Amazon 商品信息
 */
function extractAmazonContent(html, url) {
  const $ = cheerio.load(html);
  const result = { url, source: 'scraped' };

  // --- 标题 ---
  const titleSelectors = [
    '#productTitle',
    '#title',
    '[data-feature-name="title"] .product-title-word-break',
    'h1.a-size-large',
  ];
  for (const sel of titleSelectors) {
    const el = $(sel).first();
    if (el.length && el.text().trim()) {
      result.title = el.text().trim().replace(/\s+/g, ' ');
      break;
    }
  }
  if (!result.title) {
    const titleTag = $('title').text().replace(/:? Amazon\.com.*$/, '').trim();
    if (titleTag) result.title = titleTag;
  }

  // --- 五点描述 ---
  const bulletSelectors = [
    '#feature-bullets .a-list-item',
    '#feature-bullets li',
    '#featurebullets_feature_div .a-list-item',
    '[data-feature-name="featurebullets_feature_div"] .a-list-item',
    '#feature-bullets span.a-list-item',
  ];
  const bullets = [];
  for (const sel of bulletSelectors) {
    $(sel).each((i, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text && text.length > 10) bullets.push(text);
    });
    if (bullets.length >= 3) break;
  }
  result.bulletPoints = [...new Set(bullets)].slice(0, 10);

  // --- 产品描述 ---
  const descSelectors = [
    '#productDescription',
    '#productDescription_feature_div',
    '#aplus_feature_div',
    '#aplus',
    '[data-feature-name="productDescription"]',
    '#dpx-productDescription',
    '#descriptionAndDetails',
    '.productDescriptionWrapper',
  ];
  for (const sel of descSelectors) {
    const el = $(sel);
    if (el.length && el.text().trim().length > 50) {
      // 尝试获取纯文本，移除 HTML 但保留段落结构
      let desc = '';
      el.find('p, br, li, h3, h4, h5').each((i, e) => {
        const t = $(e).text().trim();
        if (t) desc += t + '\n';
      });
      if (!desc.trim()) {
        desc = el.text().trim();
      }
      result.description = desc.replace(/\n{3,}/g, '\n\n').trim();
      break;
    }
  }
  if (!result.description) {
    // 尝试从 meta 标签获取
    const metaDesc = $('meta[name="description"]').attr('content');
    if (metaDesc && metaDesc.length > 50) {
      result.description = metaDesc.replace(/\s+/g, ' ').trim();
    }
  }

  // --- About This Item (备用) ---
  if (!result.description || result.description.length < 30) {
    const aboutSel = [
      '#productOverview_feature_div .a-section',
      '.product-overview-table',
    ];
    for (const sel of aboutSel) {
      const el = $(sel);
      if (el.length && el.text().trim().length > 30) {
        result.description = el.text().trim().replace(/\s+/g, ' ');
        break;
      }
    }
  }

  return result;
}

// ==================== API 路由 ====================

/**
 * POST /api/scrape
 * 爬取单个 Amazon 商品页面
 * Body: { url: string }
 */
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '请提供 URL' });

  try {
    const response = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: 20000,
      maxRedirects: 3,
      validateStatus: s => s < 500,
    });

    if (response.status === 503) {
      return res.json({
        url,
        source: 'blocked',
        error: 'Amazon 返回 503（机器人检测）。请手动粘贴该商品的内容。',
      });
    }

    const extracted = extractAmazonContent(response.data, url);

    if (!extracted.title && !extracted.bulletPoints.length) {
      return res.json({
        url,
        source: 'blocked',
        error: '未能提取到内容，可能被拦截。请手动粘贴该商品的内容。',
        rawTitle: cheerio.load(response.data)('title').text().slice(0, 200),
      });
    }

    res.json(extracted);
  } catch (err) {
    console.error(`[scrape error] ${url}:`, err.message);
    res.json({
      url,
      source: 'error',
      error: `请求失败: ${err.message}。请手动粘贴该商品的内容。`,
    });
  }
});

/**
 * POST /api/scrape-all
 * 批量爬取多个 URL
 * Body: { urls: string[] }
 * 返回每个URL的详细状态 + 爬取结果
 */
app.post('/api/scrape-all', async (req, res) => {
  const { urls } = req.body;
  if (!urls || !urls.length) return res.status(400).json({ error: '请提供至少一个 URL' });

  const results = [];
  for (const url of urls) {
    const result = { url, success: false, source: 'error', title: null, bulletPoints: [], description: '' };
    try {
      const response = await axios.get(url, {
        headers: BROWSER_HEADERS,
        timeout: 20000,
        maxRedirects: 3,
        validateStatus: s => s < 500,
      });

      if (response.status === 503) {
        result.source = 'blocked';
        result.error = 'Amazon 返回503（机器人检测）';
      } else {
        const extracted = extractAmazonContent(response.data, url);
        if (extracted.title || extracted.bulletPoints?.length) {
          result.success = true;
          result.source = 'scraped';
          result.title = extracted.title || '';
          result.bulletPoints = extracted.bulletPoints || [];
          result.description = extracted.description || '';
        } else {
          result.source = 'blocked';
          result.error = '未能提取到内容，可能被拦截';
          const rawTitle = cheerio.load(response.data)('title').text().slice(0, 200);
          if (rawTitle) result.rawTitle = rawTitle;
        }
      }
    } catch (err) {
      result.source = 'error';
      result.error = err.message;
    }
    results.push(result);
  }

  // 汇总统计
  const stats = {
    total: results.length,
    success: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
  };

  res.json({ results, stats });
});

/**
 * POST /api/generate
 * 调用 DeepSeek v4 Pro 生成优化后的 Listing 内容
 * Body: {
 *   apiKey: string,
 *   productName: string,
 *   sellingPoints: string,
 *   notes: string,
 *   competitors: [{ url, title, bulletPoints, description }],
 *   languages: string[]  // 如 ['en', 'fr', 'de', 'es']
 * }
 */
app.post('/api/generate', async (req, res) => {
  const { apiKey, productName, sellingPoints, notes, competitors, languages, charLimits } = req.body;

  if (!apiKey) return res.status(400).json({ error: '请提供 DeepSeek API Key' });
  if (!productName) return res.status(400).json({ error: '请提供产品名称/方向' });

  // 字数限制默认值
  const limits = {
    titleMin: charLimits?.titleMin || 150,
    titleMax: charLimits?.titleMax || 200,
    bulletMin: charLimits?.bulletMin || 150,
    bulletMax: charLimits?.bulletMax || 250,
    descMin: charLimits?.descMin || 800,
    descMax: charLimits?.descMax || 2000,
  };

  // 构建竞品分析文本
  let competitorText = '';
  if (competitors && competitors.length) {
    competitorText = competitors.map((c, i) => {
      const parts = [`竞品 ${i + 1}:`];
      if (c.title) parts.push(`  标题: ${c.title}`);
      if (c.bulletPoints?.length) {
        parts.push('  五点描述:');
        c.bulletPoints.forEach((bp, j) => parts.push(`    ${j + 1}. ${bp}`));
      }
      if (c.description) parts.push(`  产品描述:\n${c.description.slice(0, 2000)}`);
      return parts.join('\n');
    }).join('\n\n---\n\n');
  }

  const langNames = {
    en: 'English (US)',
    fr: 'Français (France)',
    de: 'Deutsch (Germany)',
    es: 'Español (Spain)',
    it: 'Italiano (Italy)',
    ja: '日本語 (Japan)',
    zh: '中文 (China)',
    pt: 'Português (Brazil)',
    nl: 'Nederlands (Netherlands)',
    pl: 'Polski (Poland)',
    sv: 'Svenska (Sweden)',
    ar: 'العربية (UAE)',
    tr: 'Türkçe (Turkey)',
    ko: '한국어 (Korea)',
  };

  const targetLangs = (languages && languages.length) ? languages : ['en'];

  try {
    const results = {};

    for (const lang of targetLangs) {
      const langName = langNames[lang] || lang;
      const isEnglish = lang === 'en';

      let systemPrompt, userPrompt;

      if (isEnglish) {
        systemPrompt = `You are an expert Amazon listing optimization specialist with deep knowledge of Amazon's A9 algorithm, SEO best practices, and Amazon's terms of service. You help sellers create compelling, compliant, and high-converting product listings.

CRITICAL RULES:
1. NEVER copy competitor content directly. Always rewrite, restructure, and rephrase.
2. Follow Amazon's style guide: capitalize first letter of each word in titles, keep bullet points concise.
3. Title length: ${limits.titleMin}-${limits.titleMax} characters (STRICT limit - must be within this range).
4. Each bullet point: ${limits.bulletMin}-${limits.bulletMax} characters each (STRICT - every bullet must be in range).
5. Product description: ${limits.descMin}-${limits.descMax} characters total, use HTML formatting for A+ Content style.
6. Include relevant keywords naturally - do NOT keyword stuff.
7. Focus on benefits AND features.
8. Avoid prohibited claims (no "best", "guaranteed", "no side effects" unless substantiated).
9. No pricing, promotional language, or seller-specific info.
10. No HTML in bullet points or title.
11. CRITICAL ANTI-HALLUCINATION: NEVER invent product specifications, dimensions, materials, weights, colors, certifications, warranty terms, packaging details, or any factual product attributes that were NOT explicitly provided by the user. If data is missing, derive benefits from provided information only. DO NOT fabricate specifications under any circumstances.`;

        userPrompt = `Create an optimized Amazon product listing for:

PRODUCT: ${productName}
SELLING POINTS: ${sellingPoints || 'N/A'}
ADDITIONAL NOTES: ${notes || 'N/A'}

--- COMPETITOR ANALYSIS ---
${competitorText || 'No competitor data provided.'}
---

Please generate the following in a structured JSON format:

{
  "title": "The optimized product title (${limits.titleMin}-${limits.titleMax} chars, capitalize first letter of each major word)",
  "bulletPoints": [
    "Bullet 1 (benefit-focused, ${limits.bulletMin}-${limits.bulletMax} chars)",
    "Bullet 2",
    "Bullet 3",
    "Bullet 4", 
    "Bullet 5"
  ],
  "description": "A+ Content style product description (${limits.descMin}-${limits.descMax} chars total) in HTML format. Use <h3>, <p>, <ul>, <li>, <b> tags. Structure: About This Product / Key Features / Why Choose This Product / Specifications."
}

IMPORTANT: Return ONLY valid JSON. No markdown code blocks, no explanations. The response must parse directly as JSON.`;
      } else {
        systemPrompt = `You are an expert Amazon listing translator AND localization specialist for the ${langName} market. Your translations must feel NATIVE to local shoppers - NOT literal word-for-word translations.

CRITICAL RULES:
1. Translate culturally, not literally. Adapt idioms, phrases, and expressions to sound natural in ${langName}.
2. Research local consumer language patterns in this market.
3. Maintain Amazon compliance for the target marketplace.
4. Keep title length: ${limits.titleMin}-${limits.titleMax} characters (STRICT limit in target language).
5. Bullet points: ${limits.bulletMin}-${limits.bulletMax} characters each (STRICT - every bullet must be in range).
6. Product description: ${limits.descMin}-${limits.descMax} characters total, preserve HTML structure but translate content.
7. Use local measurement units, conventions, and terminology.
8. Never mention the word "translation" or that it was "translated from English" - it must feel original.`;

        userPrompt = `You are given an original English Amazon listing. Please create a fully localized version for the ${langName} marketplace (amazon.${lang === 'en' ? 'com' : lang}).

ORIGINAL ENGLISH LISTING:
--- TITLE ---
${results.en?.title || productName}

--- BULLET POINTS ---
${results.en?.bulletPoints ? results.en.bulletPoints.map((b, i) => `${i + 1}. ${b}`).join('\n') : 'N/A'}

--- PRODUCT DESCRIPTION ---
${results.en?.description || 'N/A'}

PRODUCT: ${productName}
SELLING POINTS: ${sellingPoints || 'N/A'}
ADDITIONAL NOTES: ${notes || 'N/A'}

Please generate the localized version as JSON:

{
  "title": "Localized title in ${langName}",
  "bulletPoints": ["Localized bullet 1", "Localized bullet 2", "Localized bullet 3", "Localized bullet 4", "Localized bullet 5"],
  "description": "Localized description preserving HTML structure"
}

IMPORTANT: Return ONLY valid JSON. No markdown code blocks.`;
      }

      // 调用 DeepSeek v4 Pro API
      try {
        const dsResponse = await axios.post(
          'https://api.deepseek.com/v1/chat/completions',
          {
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.7,
            max_tokens: 4096,
            response_format: { type: 'json_object' },
          },
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 120000,
          }
        );

        const content = dsResponse.data?.choices?.[0]?.message?.content;
        if (content) {
          try {
            const parsed = JSON.parse(content);
            results[lang] = parsed;
          } catch (parseErr) {
            // 尝试从 markdown 中提取 JSON
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              results[lang] = JSON.parse(jsonMatch[0]);
            } else {
              results[lang] = { error: 'JSON 解析失败', raw: content.slice(0, 500) };
            }
          }
        } else {
          results[lang] = { error: 'DeepSeek 返回空内容' };
        }
      } catch (apiErr) {
        console.error(`[DeepSeek error] lang=${lang}:`, apiErr.response?.data || apiErr.message);
        results[lang] = {
          error: `API 调用失败 (${lang}): ${apiErr.response?.data?.error?.message || apiErr.message}`,
        };
      }
    }

    // Auto-generate Chinese preview for review (after English is done)
    if (results.en && !results.en.error) {
      try {
        const zhSystem = `你将亚马逊Listing内容翻译成中文，仅供卖家审阅。保持HTML结构。直接返回JSON。`;
        const zhUser = `将此英文Listing翻译成中文（供卖家审阅用，非正式发布）：\n\n${JSON.stringify({ title: results.en.title, bulletPoints: results.en.bulletPoints, description: results.en.description })}\n\n返回JSON: { "title": "中文标题", "bulletPoints": ["中文卖点1",...], "description": "中文描述" }`;
        const zhResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
          model: 'deepseek-chat',
          messages: [{ role: 'system', content: zhSystem }, { role: 'user', content: zhUser }],
          temperature: 0.3, max_tokens: 4096, response_format: { type: 'json_object' },
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 });
        const zhContent = zhResp.data?.choices?.[0]?.message?.content;
        if (zhContent) {
          try { results['zh'] = JSON.parse(zhContent); } catch { results['zh'] = { title: zhContent.slice(0, 200), bulletPoints: ['翻译解析失败'], description: '' }; }
        }
      } catch (e) { /* Chinese preview is optional, silent fail */ }
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('[generate error]:', err);
    res.status(500).json({ error: `生成失败: ${err.message}` });
  }
});

/**
 * POST /api/upload-images
 * 上传 A+ Content 图片
 */
app.post('/api/upload-images', upload.array('images', 10), (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: '请至少上传一张图片' });
  }
  const files = req.files.map(f => ({
    filename: f.filename,
    url: `/uploads/${f.filename}`,
    originalName: f.originalname,
    size: f.size,
  }));
  res.json({ success: true, files });
});

/**
 * POST /api/generate-aplus
 * 生成 Amazon A+ Content / EBC
 */
app.post('/api/generate-aplus', async (req, res) => {
  const { apiKey, productName, sellingPoints, notes, productUrl, competitors, images, languages, visionModel, visionApiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: '请提供 DeepSeek API Key' });
  if (!productName) return res.status(400).json({ error: '请提供产品名称' });

  // Image analysis via GPT-4o Vision (if enabled)
  let analyzedImages = images || [];
  if (visionModel === 'openai' && visionApiKey && images && images.length) {
    try {
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const imgPath = path.join(uploadDir, img.filename);
        if (!fs.existsSync(imgPath)) continue;
        const imgData = fs.readFileSync(imgPath);
        const base64 = imgData.toString('base64');
        const ext = path.extname(img.filename).toLowerCase().replace('.', '');
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        const visionResp = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4o',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: `Describe this product image in 2-3 sentences for Amazon A+ Content. Focus on: what the product is, key visible features, materials/colors, usage scenario, and any text visible. Product context: ${productName}. Be specific and factual.` },
              { type: 'image_url', image_url: { url: `data:image/${mime};base64,${base64}`, detail: 'low' } }
            ]
          }],
          max_tokens: 300, temperature: 0.3,
        }, { headers: { 'Authorization': `Bearer ${visionApiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 });
        const desc = visionResp.data?.choices?.[0]?.message?.content?.trim();
        if (desc) {
          analyzedImages[i] = { ...img, label: `[AI Vision] ${desc}` };
        }
      }
    } catch (e) {
      console.error('[vision error]', e.response?.data || e.message);
      // Fall back to user labels on vision error
    }
  }

  const langNames = {
    en: 'English (US)', fr: 'Français (France)', de: 'Deutsch (Germany)',
    es: 'Español (Spain)', it: 'Italiano (Italy)', ja: '日本語 (Japan)',
    zh: '中文', pt: 'Português (Brazil)', nl: 'Nederlands (Netherlands)',
    pl: 'Polski (Poland)', sv: 'Svenska (Sweden)', ar: 'العربية (UAE)', tr: 'Türkçe (Turkey)',
  };
  const targetLangs = (languages && languages.length) ? languages : ['en'];

  const effectiveImages = analyzedImages;
  let imageContext = '';
  if (effectiveImages && effectiveImages.length) {
    imageContext = '\n--- UPLOADED IMAGES ---\n';
    effectiveImages.forEach((img, i) => {
      imageContext += `Image ${i + 1}: ${img.label || img.originalName || 'Product image ' + (i + 1)}\n`;
    });
  }

  let competitorText = '';
  if (competitors && competitors.length) {
    competitorText = competitors.map((c, i) => {
      const parts = [`Competitor ${i + 1}:`];
      if (c.title) parts.push(`  Title: ${c.title}`);
      if (c.bulletPoints?.length) {
        parts.push('  Bullets:');
        c.bulletPoints.slice(0, 5).forEach((bp, j) => parts.push(`    ${j + 1}. ${bp}`));
      }
      if (c.description) parts.push(`  Desc: ${c.description.slice(0, 1000)}`);
      return parts.join('\n');
    }).join('\n\n---\n\n');
  }

  let ownProductText = productUrl ? `\nProduct Page URL: ${productUrl}` : '';

  try {
    const results = {};
    for (const lang of targetLangs) {
      const langName = langNames[lang] || lang;
      const isEnglish = lang === 'en';
      const imgCount = effectiveImages ? effectiveImages.length : 0;

      if (isEnglish) {
        const systemPrompt = `You are an expert Amazon A+ Content / Enhanced Brand Content (EBC) designer. You create premium brand storytelling content that converts browsers into buyers.

CRITICAL RULES:
1. Write premium, brand-building copy. Focus on lifestyle benefits AND technical features.
2. NEVER copy competitor content. Create entirely original copy.
3. Use benefit-driven headlines. No generic titles like "High Quality".
4. For each uploaded image, create a matching content module that describes what the image shows and adds value.
5. Text per module body: 200-500 characters.
6. Headlines: 20-60 characters, punchy and benefit-focused.
7. Comparison charts: 3-5 rows max, clear winner positioning.
8. Feature highlights: 4-6 items, each with bold headline + 1-2 sentence description.
9. Return ONLY valid JSON. No markdown, no explanations.
10. CRITICAL ANTI-HALLUCINATION: NEVER fabricate product specifications, dimensions, materials, weights, colors, certifications, warranty terms, packaging, or any factual attributes NOT explicitly provided by the user. If the user didn't provide a spec, DO NOT invent it. The "technicalSpecs" section MUST ONLY contain specs explicitly mentioned in the product info, selling points, or notes. If no specs are provided, return an empty specs array. The "comparisonChart" must only compare features that can be verified from the competitor data or user-provided information. DO NOT guess or make up product details.`;

        const userPrompt = `Create a complete Amazon A+ Content package for:

PRODUCT: ${productName}
SELLING POINTS: ${sellingPoints || 'N/A'}
ADDITIONAL NOTES: ${notes || 'N/A'}${ownProductText}
${imageContext}
--- COMPETITOR ANALYSIS ---
${competitorText || 'No competitor data.'}
---

Generate this JSON structure (fill every field):

{
  "brandStory": {
    "headline": "Brand tagline (20-60 chars)",
    "body": "Brand story and mission. 300-800 chars."
  },
  "imageModules": [
    {
      "imageLabel": "Match to Image 1",
      "moduleType": "image_with_text_overlay",
      "headline": "Benefit headline (20-60 chars)",
      "body": "Description matching the image, 200-500 chars."
    }
  ],
  "featureHighlights": {
    "sectionTitle": "Key Features",
    "items": [
      { "icon": "emoji/icon concept", "headline": "Feature name", "description": "1-2 sentence benefit" }
    ]
  },
  "comparisonChart": {
    "title": "Why Choose Us",
    "headers": ["Feature", "Our Product", "Others"],
    "rows": [["Feature", "Our advantage", "Competitor limitation"]]
  },
  "technicalSpecs": {
    "title": "Technical Specifications",
    "specs": [{ "label": "Spec name", "value": "Spec value" }]
  }
}

IMPORTANT:
- Create exactly ${imgCount} imageModule(s).
- Feature highlights: 4-6 items.
- Comparison chart: 3-5 rows.
- Technical specs: 5-10 rows.
- Return ONLY valid JSON. No code blocks.`;

        const dsResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
          model: 'deepseek-chat',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          temperature: 0.7, max_tokens: 8192, response_format: { type: 'json_object' },
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 180000 });

        const content = dsResp.data?.choices?.[0]?.message?.content;
        if (content) {
          try { results[lang] = JSON.parse(content); } catch {
            const m = content.match(/\{[\s\S]*\}/);
            results[lang] = m ? JSON.parse(m[0]) : { error: 'JSON parse failed', raw: content.slice(0, 500) };
          }
        } else { results[lang] = { error: 'Empty response' }; }
      } else {
        const systemPrompt = `You are an expert Amazon A+ Content translator AND localization specialist for ${langName}. Translate culturally, NOT literally. Adapt idioms, measurements, and expressions. Maintain premium brand tone. Preserve JSON structure exactly. Return ONLY valid JSON.`;
        const userPrompt = `Localize this Amazon A+ Content for ${langName} marketplace:\n\nPRODUCT: ${productName}\nSELLING POINTS: ${sellingPoints || 'N/A'}\nNOTES: ${notes || 'N/A'}\n\nORIGINAL ENGLISH:\n${JSON.stringify(results.en, null, 2)}\n\nReturn FULL JSON with ALL text localized to ${langName}. Return ONLY valid JSON.`;

        try {
          const dsResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: 'deepseek-chat',
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            temperature: 0.7, max_tokens: 8192, response_format: { type: 'json_object' },
          }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 180000 });

          const content = dsResp.data?.choices?.[0]?.message?.content;
          if (content) {
            try { results[lang] = JSON.parse(content); } catch {
              const m = content.match(/\{[\s\S]*\}/);
              results[lang] = m ? JSON.parse(m[0]) : { error: 'JSON parse failed' };
            }
          } else { results[lang] = { error: 'Empty response' }; }
        } catch (apiErr) {
          results[lang] = { error: `API failed: ${apiErr.response?.data?.error?.message || apiErr.message}` };
        }
      }
    }
    // Auto-generate Chinese preview
    if (results.en && !results.en.error) {
      try {
        const zhSystem = `你将亚马逊A+ Content翻译成中文，仅供卖家审阅。保持JSON结构。直接返回JSON。`;
        const zhUser = `将此英文A+ Content翻译成中文（供卖家审阅用）：\n\n${JSON.stringify(results.en)}\n\n返回完整JSON结构，所有文本字段翻译为中文。`;
        const zhResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
          model: 'deepseek-chat',
          messages: [{ role: 'system', content: zhSystem }, { role: 'user', content: zhUser }],
          temperature: 0.3, max_tokens: 8192, response_format: { type: 'json_object' },
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 });
        const zhContent = zhResp.data?.choices?.[0]?.message?.content;
        if (zhContent) {
          try { results['zh'] = JSON.parse(zhContent); } catch { results['zh'] = { brandStory: { headline: '翻译失败', body: zhContent.slice(0, 500) } }; }
        }
      } catch (e) { /* optional */ }
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('[generate-aplus error]:', err);
    res.status(500).json({ error: `生成失败: ${err.message}` });
  }
});

/**
 * POST /api/sync-translations
 * 从一种语言编辑后同步翻译到其他语言
 */
app.post('/api/sync-translations', async (req, res) => {
  const { apiKey, sourceLang, sourceContent, targetLangs, mode } = req.body;
  if (!apiKey) return res.status(400).json({ error: '请提供 API Key' });
  if (!sourceContent) return res.status(400).json({ error: '缺少源内容' });
  if (!targetLangs?.length) return res.status(400).json({ error: '缺少目标语言' });

  const langNames = {
    en: 'English (US)', fr: 'Français (France)', de: 'Deutsch (Germany)',
    es: 'Español (Spain)', it: 'Italiano (Italy)', ja: '日本語 (Japan)',
    zh: '中文', pt: 'Português (Brazil)', nl: 'Nederlands (Netherlands)',
    pl: 'Polski (Poland)', sv: 'Svenska (Sweden)', ar: 'العربية (UAE)', tr: 'Türkçe (Turkey)',
  };
  const srcName = langNames[sourceLang] || sourceLang;
  const results = {};
  for (const tgt of targetLangs) {
    if (tgt === sourceLang) { results[tgt] = sourceContent; continue; }
    const tgtName = langNames[tgt] || tgt;
    try {
      const isListing = mode === 'listing';
      const sp = `Translate from ${srcName} to ${tgtName} culturally, not literally. Preserve JSON structure. Return ONLY valid JSON.`;
      const up = `Translate this ${isListing ? 'Amazon listing' : 'Amazon A+ Content'} from ${srcName} to ${tgtName}. Only translate text values, preserve all keys and structure:\n\n${JSON.stringify(sourceContent)}\n\nReturn ONLY valid JSON.`;
      const dsResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: sp }, { role: 'user', content: up }],
        temperature: 0.3, max_tokens: 8192, response_format: { type: 'json_object' },
      }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 120000 });
      const content = dsResp.data?.choices?.[0]?.message?.content;
      if (content) {
        try { results[tgt] = JSON.parse(content); } catch { const m = content.match(/\{[\s\S]*\}/); results[tgt] = m ? JSON.parse(m[0]) : { error: 'JSON parse' }; }
      } else { results[tgt] = { error: 'Empty' }; }
    } catch (e) { results[tgt] = { error: e.response?.data?.error?.message || e.message }; }
  }
  res.json({ success: true, results });
});

// ==================== 竞品评论情感分析器 ====================

/** 增强版请求头 - 模拟真实浏览器 */
const REVIEW_HEADERS_POOL = [
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Ch-Ua': '"Chromium";v="131", "Google Chrome";v="131"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
    'Connection': 'keep-alive',
  },
  {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
  },
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
  },
];

function getRandomReviewHeaders(referer) {
  const base = { ...REVIEW_HEADERS_POOL[Math.floor(Math.random() * REVIEW_HEADERS_POOL.length)] };
  if (referer) base.Referer = referer;
  return base;
}

/**
 * 从URL提取ASIN
 */
function extractAsin(url) {
  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/product\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /ASIN[=:]?\s*([A-Z0-9]{10})/i
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

/**
 * 从亚马逊评论页面HTML中提取评论数据
 */
function parseReviewsFromHtml(html) {
  const reviews = [];
  const $ = cheerio.load(html);

  // 方法1：使用 data-hook="review" 选择器
  $('[data-hook="review"]').each((i, el) => {
    const $el = $(el);
    
    // 评分
    let rating = 0;
    const ratingText = $el.find('[data-hook="review-star-rating"] .a-icon-alt').text()
      || $el.find('.review-rating .a-icon-alt').text()
      || $el.find('i[data-hook="review-star-rating"] span').text();
    const ratingMatch = ratingText.match(/([\d.]+)/);
    if (ratingMatch) rating = parseFloat(ratingMatch[1]);

    // 标题
    const title = $el.find('[data-hook="review-title"] span').last().text().trim()
      || $el.find('.review-title').text().trim();

    // 正文
    const text = $el.find('[data-hook="review-body"] span').text().trim()
      || $el.find('.review-text').text().trim();

    // 日期
    const date = $el.find('[data-hook="review-date"]').text().trim();

    // 已验证购买
    const verified = $el.text().includes('Verified Purchase')
      || $el.text().includes('已确认购买');

    if (text.length > 10) {
      reviews.push({ rating, title, text, date, verified });
    }
  });

  // 方法2：如果没提取到，尝试正则匹配
  if (reviews.length === 0) {
    const reviewBodyRegex = /<span[^>]*data-hook="review-body"[^>]*class="[^"]*review-text[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
    let match;
    while ((match = reviewBodyRegex.exec(html)) !== null) {
      const text = match[1].replace(/<[^>]+>/g, '').trim();
      if (text.length > 10) {
        reviews.push({ rating: 0, title: '', text, date: '', verified: false });
      }
    }
  }

  return reviews;
}

/**
 * 爬取单个产品的评论 - Puppeteer + Cookie 版
 */
async function scrapeAmazonReviews(productUrl, count = 30, cookies = null) {
  const asin = extractAsin(productUrl);
  if (!asin) throw new Error(`无法从URL中提取ASIN: ${productUrl}`);

  let domain = 'amazon.com';
  try { domain = new URL(productUrl).hostname.replace('www.', ''); } catch (_) {}

  const puppeteer = require('puppeteer');
  let browser = null;
  const reviews = [];

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    // 如果提供了cookie，先设置
    if (cookies && cookies.length > 0) {
      await page.setCookie(...cookies);
    }

    // 直接访问评论页
    const reviewUrl = `https://${domain}/product-reviews/${asin}/?sortBy=recent`;
    await page.goto(reviewUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // 检查是否被要求登录
    const isSignIn = await page.evaluate(() => {
      return document.title.includes('Sign-In') || 
             document.body.innerText.includes('Sign in') ||
             !!document.querySelector('form[name="signIn"]');
    });

    if (isSignIn) {
      throw new Error(cookies && cookies.length > 0
        ? 'Cookie 可能已过期，请重新导出。在浏览器登录Amazon后，按F12→Application→Cookies→复制所有cookie'
        : 'Amazon 需要登录。请在浏览器登录Amazon后导出Cookie粘贴到上方输入框');
    }

    // 提取评论
    const extractReviews = async () => {
      return await page.evaluate(() => {
        const reviews = [];
        document.querySelectorAll('[data-hook="review"]').forEach(el => {
          try {
            const ratingEl = el.querySelector('[data-hook="review-star-rating"] .a-icon-alt');
            let rating = 0;
            if (ratingEl) { const m = ratingEl.textContent.match(/([\d.]+)/); if (m) rating = parseFloat(m[1]); }
            const titleEl = el.querySelector('[data-hook="review-title"] span:last-child');
            const bodyEl = el.querySelector('[data-hook="review-body"] span');
            const dateEl = el.querySelector('[data-hook="review-date"]');
            const text = bodyEl ? bodyEl.textContent.trim() : '';
            if (text.length > 10) {
              reviews.push({
                rating, title: titleEl ? titleEl.textContent.trim() : '',
                text, date: dateEl ? dateEl.textContent.trim() : '',
                verified: el.textContent.includes('Verified Purchase')
              });
            }
          } catch (e) {}
        });
        return reviews;
      });
    };

    let pageReviews = await extractReviews();
    for (const r of pageReviews) {
      if (reviews.length >= count) break;
      reviews.push({ ...r, asin, productUrl });
    }

    // 翻页
    let pageNum = 2;
    while (reviews.length < count && pageNum <= 5) {
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
      try {
        await page.goto(
          `https://${domain}/product-reviews/${asin}/ref=cm_cr_arp_d_paging_btm_next_${pageNum}?pageNumber=${pageNum}&sortBy=recent`,
          { waitUntil: 'networkidle2', timeout: 20000 }
        );
        await new Promise(r => setTimeout(r, 1500));
        pageReviews = await extractReviews();
        if (pageReviews.length === 0) break;
        for (const r of pageReviews) {
          if (reviews.length >= count) break;
          reviews.push({ ...r, asin, productUrl });
        }
        pageNum++;
      } catch (err) { break; }
    }

    return reviews;
  } finally {
    if (browser) await browser.close();
  }
}

/** POST /api/scrape-reviews - 爬取多个产品的评论 */
app.post('/api/scrape-reviews', async (req, res) => {
  const { urls, count = 30, cookieJson } = req.body;

  if (!urls || !urls.length) {
    return res.status(400).json({ error: '请提供至少一个Amazon产品链接' });
  }

  // 解析 cookie
  let cookies = null;
  if (cookieJson) {
    try { cookies = typeof cookieJson === 'string' ? JSON.parse(cookieJson) : cookieJson; }
    catch (_) { /* ignore invalid cookies */ }
  }

  const results = {
    reviews: [],
    stats: { successCount: 0, failCount: 0, blockedCount: 0, totalReviews: 0, errors: [] },
    perUrl: []
  };

  for (const url of urls) {
    const urlResult = { url, status: 'pending', reviewsCount: 0, error: null };
    try {
      const perUrl = Math.ceil(count / urls.length);
      const reviews = await scrapeAmazonReviews(url, perUrl, cookies);
      if (reviews.length > 0) {
        results.reviews.push(...reviews);
        results.stats.successCount++;
        results.stats.totalReviews += reviews.length;
        urlResult.status = 'success';
        urlResult.reviewsCount = reviews.length;
      } else {
        results.stats.failCount++;
        urlResult.status = 'empty';
        urlResult.error = '页面可访问但未提取到评论';
      }
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('503') || msg.includes('屏蔽')) {
        results.stats.blockedCount++;
        urlResult.status = 'blocked';
      } else {
        results.stats.failCount++;
        urlResult.status = 'error';
      }
      urlResult.error = msg;
      results.stats.errors.push({ url, message: msg });
    }
    results.perUrl.push(urlResult);
  }

  if (results.reviews.length === 0) {
    return res.json({
      success: false,
      error: '未能获取评论。\n\n⚠️ Amazon评论需要登录账号才能查看，URL自动爬取受限于：\n• 需要Amazon登录session\n• 中国IP可能被限制访问\n\n📋 推荐使用"手动粘贴评论"：\n在浏览器打开竞品评论页 → 全选复制 → 粘贴到输入框即可',
      stats: results.stats,
      perUrl: results.perUrl
    });
  }

  const avgRating = (results.reviews.reduce((s, r) => s + r.rating, 0) / results.reviews.length).toFixed(1);
  results.stats.avgRating = avgRating;
  results.stats.positiveCount = results.reviews.filter(r => r.rating >= 4).length;
  results.stats.negativeCount = results.reviews.filter(r => r.rating <= 2).length;

  res.json({ success: true, data: results });
});

/** POST /api/analyze-reviews - AI分析评论 */
app.post('/api/analyze-reviews', async (req, res) => {
  const { apiKey, reviews, productUrls } = req.body;

  if (!apiKey) return res.status(400).json({ error: '请提供 DeepSeek API Key' });
  if (!reviews || !reviews.length) return res.status(400).json({ error: '请提供评论数据' });

  const total = reviews.length;
  const avgRating = (reviews.reduce((s, r) => s + r.rating, 0) / total).toFixed(1);
  const positive = reviews.filter(r => r.rating >= 4).length;
  const negative = reviews.filter(r => r.rating <= 2).length;
  const neutral = total - positive - negative;

  const reviewSummaries = reviews.map(r =>
    `[${r.rating || '?'}★] ${r.title ? r.title + ': ' : ''}${r.text.substring(0, 400)}`
  ).join('\n---\n');

  const systemPrompt = `You are an expert Amazon product analyst specializing in competitor review analysis. You help sellers understand market gaps, customer pain points, and product improvement opportunities through deep analysis of customer reviews.

CRITICAL RULES:
1. Be specific and data-driven - mention actual complaint frequencies
2. Output in CLEAN MARKDOWN FORMAT in Chinese
3. Categorize pain points by type (materials, sizing, functionality, packaging, odor, color, etc.)
4. Prioritize insights by business impact
5. Include actionable recommendations
6. NEVER fabricate data - base everything on the provided reviews`;

  const userPrompt = `Analyze the following ${total} competitor product reviews and produce a comprehensive report in Chinese.

**Review Statistics:**
- Total: ${total} reviews
- Average rating: ${avgRating}/5
- Positive (4-5★): ${positive} (${Math.round(positive/total*100)}%)
- Negative (1-2★): ${negative} (${Math.round(negative/total*100)}%)
- Neutral (3★): ${neutral} (${Math.round(neutral/total*100)}%)

**Product URLs Analyzed:**
${productUrls ? productUrls.join('\n') : 'N/A'}

**Reviews:**
${reviewSummaries}

---

**Please output the following analysis in Chinese markdown format:**

## 🔥 高频痛点（消费者最不满意的地方）
List 5-8 pain points with frequency. Categorize by type (材质/尺寸/功能/包装/异味/色差/其他).

## ⭐ 高频赞美（消费者最喜欢的地方）
List 5-8 praise points with frequency indicators.

## 💡 未满足需求（消费者希望有但没有的）
List 3-6 unmet needs, especially from "希望"/"如果…就好了"/"建议" patterns.

## 🎯 使用场景洞察
List 3-6 real usage scenarios discovered from reviews.

## 📊 你应该强调什么（卖点建议）
5-8 actionable selling point directions.

## ⚠️ 你应该避免什么（避坑指南）
5-8 specific pitfalls to avoid, based on negative reviews.

## 🔧 产品改进建议（按优先级排序）
5-8 specific product improvement suggestions.

## 📈 综合评分卡
| 维度 | 评分(1-10) | 说明 |
|------|-----------|------|
| 产品质量 | - | - |
| 性价比 | - | - |
| 包装 | - | - |
| 描述准确性 | - | - |
| 客户满意度 | - | - |`;

  try {
    const dsResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 4096,
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 180000
    });

    const content = dsResp.data?.choices?.[0]?.message?.content;
    if (!content) return res.json({ success: false, error: 'DeepSeek 返回空内容' });

    res.json({
      success: true,
      data: {
        report: content,
        stats: { total, avgRating, positive, negative, neutral }
      }
    });
  } catch (err) {
    console.error('[AnalyzeReviews Error]:', err.response?.data || err.message);
    res.json({ success: false, error: err.response?.data?.error?.message || err.message });
  }
});

// 启动服务（本地开发） / Vercel serverless 导出
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`\n🚀 亚马逊AI工作流已启动: http://localhost:${PORT}\n`);
    console.log('  功能：');
    console.log('  📋 竞品页面爬取（最多5个）');
    console.log('  🤖 DeepSeek v4 Pro 内容优化生成');
    console.log('  🌍 多语言本地化翻译');
    console.log('  📊 竞品评论情感分析');
    console.log('  📋 快速版本切换\n');
  });
}
