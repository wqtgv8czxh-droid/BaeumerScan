import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL = Deno.env.get("CLAUDE_EDGES_MODEL") ?? "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `Du analysierst ein Foto, das ein Dokument enthält (Papier, Rechnung, Vertrag, Brief, Karte, Ausweis).

AUFGABE: Identifiziere das Hauptdokument und gib seine achsen-parallele Bounding Box im Bild zurück.

ANTWORTFORMAT: AUSSCHLIESSLICH JSON, ohne Markdown, ohne Erklärungen:
{"x": number, "y": number, "w": number, "h": number, "confidence": "high"|"medium"|"low"}

REGELN:
- Alle Werte als Prozent der Bilddimensionen (0 = linker/oberer Rand, 100 = rechter/unterer Rand)
- x, y: Position der linken oberen Ecke des Dokuments
- w, h: Breite und Höhe des Dokuments
- Box leicht großzügig (~2-5% Rand außen ok), aber Hintergrund/Tischplatte ausschließen
- Bei rotiertem Dokument: die enge umschließende achsenparallele Box wählen
- confidence: "high" bei klaren Kanten, "medium" bei teilweise verdeckt, "low" wenn unsicher
- Wenn KEIN Dokument erkennbar: {"x":5,"y":5,"w":90,"h":90,"confidence":"low"}`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Nicht autorisiert" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authError } = await sb.auth.getUser();
    if (authError || !user) throw new Error("Nicht autorisiert");

    const { imageBase64, mediaType } = await req.json();
    if (!imageBase64) throw new Error("Kein Bild übergeben");

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_KEY") ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 150,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType || "image/jpeg",
                  data: imageBase64,
                },
              },
              { type: "text", text: "Gib die Bounding Box des Dokuments zurück." },
            ],
          },
        ],
      }),
    });

    const data = await apiRes.json();
    const raw = data.content?.[0]?.text || "";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    let bbox = null;
    try {
      bbox = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) bbox = JSON.parse(match[0]);
    }

    return new Response(JSON.stringify({ bbox, usage: data.usage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
