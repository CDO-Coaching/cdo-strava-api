/**
 * CDO Coaching — Strava API Server
 * Gère l'OAuth Strava et les webhooks d'activité.
 */

import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "https://www.cdocoaching.com" }));

// ─── Supabase (service role pour écriture) ────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Strava config ────────────────────────────────────────────────────────────
const STRAVA_CLIENT_ID     = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const FRONTEND_URL         = process.env.FRONTEND_URL || "https://www.cdocoaching.com";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "cdo_strava_webhook_2024";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function refreshStravaToken(refreshToken) {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  return res.json();
}

async function getValidToken(athleteId) {
  const { data: token } = await supabase
    .from("strava_tokens")
    .select("*")
    .eq("athlete_id", athleteId)
    .single();

  if (!token) return null;

  // Si le token expire dans moins de 5 minutes, on le rafraîchit
  if (token.expires_at < Math.floor(Date.now() / 1000) + 300) {
    const refreshed = await refreshStravaToken(token.refresh_token);
    if (refreshed.access_token) {
      await supabase
        .from("strava_tokens")
        .update({
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          expires_at: refreshed.expires_at,
          updated_at: new Date().toISOString(),
        })
        .eq("athlete_id", athleteId);
      return refreshed.access_token;
    }
  }
  return token.access_token;
}

async function importActivity(stravaActivityId, athleteId, accessToken) {
  // Récupère les détails de l'activité depuis Strava
  const res = await fetch(`https://www.strava.com/api/v3/activities/${stravaActivityId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const activity = await res.json();

  if (!activity.id) return;

  // Filtre : seulement les activités de course / cardio
  const CARDIO_TYPES = ["Run", "TrailRun", "Walk", "Hike", "Ride", "Swim", "VirtualRun"];
  if (!CARDIO_TYPES.includes(activity.sport_type)) return;

  // Calcule les zones FC depuis les splits (FC moy par km × durée)
  // Zones basées sur % FC max : Z1<60%, Z2 60-70%, Z3 70-80%, Z4 80-90%, Z5>90%
  let heartRateZones = null;
  if (activity.average_heartrate && activity.max_heartrate && activity.splits_metric?.length) {
    const maxHr = activity.max_heartrate;
    const zoneLimits = [0, 0.60, 0.70, 0.80, 0.90, 1.10]; // bornes en % FC max
    const timeInZone = [0, 0, 0, 0, 0]; // Z1..Z5 en secondes

    for (const split of activity.splits_metric) {
      const hr = split.average_heartrate;
      const t  = split.moving_time;
      if (!hr || !t) continue;
      const pct = hr / maxHr;
      const zIdx = zoneLimits.findIndex((lim, i) => pct < zoneLimits[i + 1]) - 1;
      const z = Math.max(0, Math.min(4, zIdx < 0 ? 4 : zIdx));
      timeInZone[z] += t;
    }

    heartRateZones = timeInZone.map((t, i) => ({
      zone: i + 1,
      min: Math.round(maxHr * zoneLimits[i]),
      max: i < 4 ? Math.round(maxHr * zoneLimits[i + 1]) : -1,
      time_seconds: Math.round(t),
    })).filter(z => z.time_seconds > 0);

    if (!heartRateZones.length) heartRateZones = null;
  }

  // Fallback : essaie l'endpoint /zones de Strava si pas de zones calculées
  if (!heartRateZones && activity.average_heartrate) {
    try {
      const zonesRes = await fetch(`https://www.strava.com/api/v3/activities/${stravaActivityId}/zones`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (zonesRes.ok) {
        const zonesData = await zonesRes.json();
        if (zonesData.heart_rate?.zones?.length) {
          heartRateZones = zonesData.heart_rate.zones.map((z, i) => ({
            zone: i + 1, min: z.min, max: z.max, time_seconds: z.time,
          })).filter(z => z.time_seconds > 0);
        }
      }
    } catch (e) { /* silencieux */ }
  }

  await supabase.from("strava_activities").upsert({
    athlete_id: athleteId,
    strava_activity_id: activity.id,
    name: activity.name,
    sport_type: activity.sport_type,
    start_date: activity.start_date,
    distance_meters: activity.distance,
    moving_time_seconds: activity.moving_time,
    average_speed_ms: activity.average_speed,
    max_speed_ms: activity.max_speed || null,
    average_heartrate: activity.average_heartrate || null,
    max_heartrate: activity.max_heartrate || null,
    total_elevation_gain: activity.total_elevation_gain || 0,
    average_cadence: activity.average_cadence || null,
    calories: activity.calories || null,
    suffer_score: activity.suffer_score || null,
    average_watts: activity.average_watts || null,
    heart_rate_zones: heartRateZones,
    splits_metric: activity.splits_metric || null,
  }, { onConflict: "strava_activity_id" });
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => res.json({ status: "ok", service: "CDO Strava API" }));

// 1. OAuth callback — Strava redirige ici après autorisation de l'athlète
app.get("/auth/strava/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${FRONTEND_URL}/sportif/profil?strava=error`);
  }

  if (!code || !state) {
    return res.status(400).send("Paramètres manquants");
  }

  try {
    // Échange le code contre des tokens
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error("Strava token error:", tokenData);
      return res.redirect(`${FRONTEND_URL}/sportif/profil?strava=error`);
    }

    // state = athlete_id (UUID Supabase) passé par le frontend
    const athleteId = state;

    // Sauvegarde les tokens
    await supabase.from("strava_tokens").upsert({
      athlete_id: athleteId,
      strava_athlete_id: tokenData.athlete.id,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: tokenData.expires_at,
      scope: tokenData.scope,
      updated_at: new Date().toISOString(),
    }, { onConflict: "strava_athlete_id" });

    // Importe les 30 dernières activités immédiatement
    const activitiesRes = await fetch(
      "https://www.strava.com/api/v3/athlete/activities?per_page=30",
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
    const activities = await activitiesRes.json();
    for (const act of activities) {
      await importActivity(act.id, athleteId, tokenData.access_token);
    }

    res.redirect(`${FRONTEND_URL}/sportif/profil?strava=connected`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.redirect(`${FRONTEND_URL}/sportif/profil?strava=error`);
  }
});

// 2. Webhook Strava — vérification (GET)
app.get("/webhooks/strava", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("Strava webhook verified");
    res.json({ "hub.challenge": challenge });
  } else {
    res.status(403).send("Forbidden");
  }
});

// 3. Webhook Strava — réception d'activité (POST)
app.post("/webhooks/strava", async (req, res) => {
  res.status(200).send("EVENT_RECEIVED"); // Répondre vite à Strava

  const { object_type, aspect_type, object_id, owner_id } = req.body;

  // On ne traite que les nouvelles activités
  if (object_type !== "activity" || aspect_type !== "create") return;

  try {
    // Retrouve l'athlète depuis son strava_athlete_id
    const { data: tokenRow } = await supabase
      .from("strava_tokens")
      .select("athlete_id, access_token, refresh_token, expires_at")
      .eq("strava_athlete_id", owner_id)
      .single();

    if (!tokenRow) return;

    const accessToken = await getValidToken(tokenRow.athlete_id);
    if (!accessToken) return;

    await importActivity(object_id, tokenRow.athlete_id, accessToken);
    console.log(`✅ Activité ${object_id} importée pour l'athlète ${tokenRow.athlete_id}`);
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// 4. Statut de connexion Strava (appelé par le frontend)
app.get("/strava/status/:athleteId", async (req, res) => {
  const { data } = await supabase
    .from("strava_tokens")
    .select("strava_athlete_id, created_at")
    .eq("athlete_id", req.params.athleteId)
    .single();

  res.json({ connected: !!data, stravaAthleteId: data?.strava_athlete_id || null });
});

// 5. Déconnexion Strava
app.delete("/strava/disconnect/:athleteId", async (req, res) => {
  await supabase.from("strava_tokens").delete().eq("athlete_id", req.params.athleteId);
  res.json({ success: true });
});

// 6. Sync manuel — récupère les 30 dernières activités depuis Strava
app.post("/strava/sync/:athleteId", async (req, res) => {
  const { athleteId } = req.params;
  try {
    const accessToken = await getValidToken(athleteId);
    if (!accessToken) {
      return res.status(401).json({ error: "Token Strava invalide ou expiré" });
    }

    const activitiesRes = await fetch(
      "https://www.strava.com/api/v3/athlete/activities?per_page=30",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const activities = await activitiesRes.json();

    if (!Array.isArray(activities)) {
      return res.status(500).json({ error: "Réponse Strava invalide", detail: activities });
    }

    let imported = 0;
    for (const act of activities) {
      await importActivity(act.id, athleteId, accessToken);
      imported++;
    }

    // Mise à jour des session_exercises déjà liées — on passe par strava_activities
    // (session_exercises n'a pas de colonne sportif_id, on filtre via athlete_id sur strava_activities)
    const { data: athleteActivities } = await supabase
      .from("strava_activities")
      .select("strava_activity_id, average_heartrate, max_heartrate, average_cadence, total_elevation_gain, calories, heart_rate_zones")
      .eq("athlete_id", athleteId);

    let updated = 0;
    for (const stravaAct of athleteActivities || []) {
      const { data: exRows } = await supabase
        .from("session_exercises")
        .select("id")
        .eq("linked_strava_activity_id", stravaAct.strava_activity_id);

      for (const ex of exRows || []) {
        await supabase
          .from("session_exercises")
          .update({
            actual_avg_heart_rate: stravaAct.average_heartrate ? Math.round(stravaAct.average_heartrate) : null,
            actual_max_heart_rate: stravaAct.max_heartrate ? Math.round(stravaAct.max_heartrate) : null,
            actual_cadence: stravaAct.average_cadence ?? null,
            actual_elevation_gain: stravaAct.total_elevation_gain ?? null,
            actual_calories: stravaAct.calories ?? null,
            actual_heart_rate_zones: stravaAct.heart_rate_zones ?? null,
          })
          .eq("id", ex.id);
        updated++;
      }
    }

    console.log(`🔄 Sync manuel : ${imported} activités importées, ${updated} séances mises à jour pour ${athleteId}`);
    res.json({ success: true, imported, updated });
  } catch (err) {
    console.error("Sync error:", err);
    res.status(500).json({ error: "Erreur lors de la synchronisation" });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 CDO Strava API running on port ${PORT}`));
