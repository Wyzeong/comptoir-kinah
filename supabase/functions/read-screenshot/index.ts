// Edge Function Supabase : lit une capture de l'hôtel des ventes avec Gemini.
// La clé GEMINI_API_KEY est un secret Supabase : elle n'apparaît jamais dans le site.
import { createClient } from 'npm:@supabase/supabase-js@2';

const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.7-flash';
// Modèles de secours essayés dans l'ordre si le principal est surchargé (503) ou à court de quota (429)
const FALLBACKS = (Deno.env.get('GEMINI_FALLBACKS') ?? 'gemini-3.7-flash,gemini-2.5-flash')
  .split(',').map((m) => m.trim()).filter((m) => m && m !== MODEL);
const MODELS = [MODEL, ...FALLBACKS];
const MAX_BASE64 = 8_000_000; // ~6 Mo d'image
const MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const MARKET_PROMPT = `You are reading a screenshot of the auction house (trade broker) of the MMORPG Aion 2.
Extract every item listing that is visible.

For each listing return:
- name: the item name exactly as displayed, without surrounding brackets [ ].
  If the name is cut off with an ellipsis, keep the ellipsis "…" at the end and set truncated to true.
- unit_price: the price of ONE unit in kinah, as an integer without separators.
  If only the total price of a stack is shown, divide it by the quantity.
  If the price cannot be read with confidence, use null.
- quantity: the stack size of the listing if displayed, otherwise null.
- truncated: true if the name is cut off, otherwise false.

Rules:
- Ignore menus, filters, tabs, tooltips, buttons and the player's own kinah balance.
- If the same item appears in several listings, return each listing separately.
- Never invent an item or a price that is not visible.
- If no listing is visible, return an empty list.`;

const MARKET_SCHEMA = {
  type: 'OBJECT',
  properties: {
    rows: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          unit_price: { type: 'INTEGER', nullable: true },
          quantity: { type: 'INTEGER', nullable: true },
          truncated: { type: 'BOOLEAN' },
        },
        required: ['name', 'unit_price', 'truncated'],
      },
    },
  },
  required: ['rows'],
};

// Réflexion réduite au minimum : la lecture d'une capture n'en a pas besoin et c'est beaucoup plus rapide
function thinkingConfig(model: string) {
  if (model.startsWith('gemini-2.5')) return { thinkingBudget: 0 };
  if (model.startsWith('gemini-3') || model.includes('latest')) return { thinkingLevel: 'low' };
  return undefined;
}

async function callGemini(model: string, mimeType: string, image: string, withThinking = true): Promise<Response | 'timeout'> {
  const started = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(100_000),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { inline_data: { mime_type: mimeType, data: image } },
              { text: MARKET_PROMPT },
            ],
          }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: MARKET_SCHEMA,
            ...(withThinking && thinkingConfig(model) ? { thinkingConfig: thinkingConfig(model) } : {}),
          },
        }),
      },
    );
    console.log(`Gemini ${model} : ${res.status} en ${Date.now() - started} ms`);
    // Si ce modèle refuse le réglage de réflexion, on réessaie sans
    if (res.status === 400 && withThinking && thinkingConfig(model)) {
      const body = await res.clone().text();
      if (/thinking/i.test(body)) return callGemini(model, mimeType, image, false);
    }
    return res;
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      console.error(`Gemini ${model} : pas de réponse après ${Date.now() - started} ms`);
      return 'timeout';
    }
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée.' }, 405);

  try {
    if (!GEMINI_KEY) return json({ error: 'Le secret GEMINI_API_KEY n’est pas configuré.' }, 500);

    const auth = req.headers.get('Authorization');
    if (!auth) return json({ error: 'Connexion requise.' }, 401);

    // Client Supabase avec les droits du joueur : la RLS et is_member() s'appliquent
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: auth } },
    });

    const { data: allowed, error: quotaError } = await sb.rpc('consume_ocr_quota');
    if (quotaError) return json({ error: `Vérification du quota impossible : ${quotaError.message}` }, 403);
    if (!allowed) return json({ error: 'Quota de lecture du jour atteint, ou compte non membre du groupe.' }, 429);

    const { image, mimeType, mode } = await req.json();
    if (typeof image !== 'string' || image.length === 0) return json({ error: 'Image manquante.' }, 400);
    if (image.length > MAX_BASE64) return json({ error: 'Image trop lourde.' }, 413);
    if (!MIME_TYPES.includes(mimeType)) return json({ error: 'Format d’image non pris en charge.' }, 400);
    if (mode !== 'market') return json({ error: 'Mode de lecture inconnu.' }, 400);

    let res: Response | 'timeout' = 'timeout';
    let used = MODEL;
    for (const model of MODELS) {
      used = model;
      res = await callGemini(model, mimeType, image);
      // Surcharge, quota ou délai dépassé : on passe au modèle suivant
      if (res === 'timeout' || res.status === 503 || res.status === 429) continue;
      break;
    }

    if (res === 'timeout') {
      return json({ error: 'Gemini n’a pas répondu à temps. Réessaie dans quelques minutes.' }, 504);
    }
    if (res.status === 503) {
      return json({ error: 'Les serveurs Gemini sont surchargés en ce moment. Réessaie dans quelques minutes.' }, 503);
    }
    if (res.status === 429) {
      return json({ error: 'Limite de l’offre gratuite Gemini atteinte. Réessaie plus tard.' }, 429);
    }
    if (!res.ok) {
      const detail = await res.text();
      console.error('Gemini', used, res.status, detail);
      return json({ error: `Gemini a répondu ${res.status} avec le modèle ${used}.` }, 502);
    }

    const data = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
    if (!text) return json({ error: 'Gemini n’a rien renvoyé pour cette capture.' }, 502);

    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    return json({ rows, model: used });
  } catch (e) {
    console.error(e);
    return json({ error: `Erreur inattendue : ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});
