import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-4-6";

const SYSTEM_PROMPT = `Du bist ein präziser deutschsprachiger Dokumenten-Analyst für ein privates Familien-Dokumentenarchiv. Lese das Bild sorgfältig und extrahiere strukturierte Daten.

REGELN:
- Antworte AUSSCHLIESSLICH mit gültigem JSON-Objekt — kein Markdown, keine Einleitung, keine Erklärung
- Bei unsicheren oder fehlenden Werten: null verwenden, niemals raten
- Deutsche Zahlenformate normalisieren: "1.234,56" → 1234.56
- Datumsangaben immer als YYYY-MM-DD

FELDER:
- text: Vollständiger Volltext des Dokuments. Zeilenumbrüche als \\n. Originalsprache erhalten. Bei mehreren Seiten: "\\n--- Seite N ---\\n" als Trenner zwischen den Seiten.
- titel: Prägnant, max 60 Zeichen. Startet mit der Dokumentart und enthält den wichtigsten Identifikator. Beispiele: "Rechnung Vodafone 11/2025", "Mietvertrag Hamburg Eppendorf", "Versicherungspolice HUK24 KFZ".
- typ: Genau einer von "Rechnung", "Vertrag", "Allgemein".
- datum: Hauptdatum (Rechnungsdatum, Vertragsdatum, Ausstellungsdatum).
- betrag: Gesamtbetrag / Endsumme als Zahl (Punkt als Dezimaltrenner). Bei Verträgen ohne klare Endsumme: null.
- waehrung: ISO-Code (EUR, USD, CHF, …). Default EUR wenn unklar.
- tags: 2-5 spezifische Tags: Anbieter/Absender (z.B. "Vodafone"), Kategorie (z.B. "Mobilfunk", "Strom", "Miete"), ggf. Rechnungs- oder Vertragsnummer.

JSON-SCHEMA:
{"text": string, "titel": string, "typ": "Rechnung"|"Vertrag"|"Allgemein", "datum": string|null, "betrag": number|null, "waehrung": string, "tags": string[]}`;

interface ImageInput {
  data: string;
  mediaType: string;
}

function normalizeImages(payload: any): ImageInput[] {
  if (Array.isArray(payload.imagesBase64) && payload.imagesBase64.length > 0) {
    return payload.imagesBase64.map((img: any) =>
      typeof img === "string"
        ? { data: img, mediaType: payload.mediaType || "image/jpeg" }
        : { data: img.data, mediaType: img.mediaType || "image/jpeg" }
    );
  }
  if (payload.imageBase64) {
    return [{ data: payload.imageBase64, mediaType: payload.mediaType || "image/jpeg" }];
  }
  return [];
}

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

    const payload = await req.json();
    const images = normalizeImages(payload);
    if (images.length === 0) throw new Error("Kein Bild übergeben");

    const content: any[] = [];
    images.forEach((img, idx) => {
      if (images.length > 1) {
        content.push({ type: "text", text: `Seite ${idx + 1}:` });
      }
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.data,
        },
      });
    });
    const userPrompt =
      images.length > 1
        ? `Dieses Dokument hat ${images.length} Seiten. Analysiere alle Seiten zusammen als ein zusammenhängendes Dokument und fülle das JSON aus. Das Feld "text" enthält den Volltext aller Seiten, mit "\\n--- Seite N ---\\n" als Trenner.`
        : "Analysiere dieses Dokument und fülle das JSON aus.";
    content.push({ type: "text", text: userPrompt });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_KEY") ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content }],
      }),
    });

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
