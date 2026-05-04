const notionHeaders = {
  "Authorization": `Bearer ${NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json"
};

let projectCache = {};

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function extractNotionField(prop) {
  if (!prop) return null;
  const type = prop.type;
  if (type === "title" || type === "rich_text") {
    return prop[type] && prop[type].length > 0 ? prop[type][0].plain_text : null;
  }
  if (type === "date") return prop.date ? prop.date.start : null;
  if (type === "status") return prop.status ? prop.status.name : null;
  if (type === "relation") return prop.relation && prop.relation.length > 0 ? prop.relation[0].id : null;
  return null;
}

/**
 * Normalisiert ein Datum auf einen YYYY-MM-DD String (lokal, ohne Timezone-Drift).
 */
function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Parst einen Notion-Datumsstring (YYYY-MM-DD oder ISO 8601) in ein
 * lokales Date-Objekt, ohne UTC-Timezone-Drift.
 */
function parseDateSafe(dateStr) {
  if (!dateStr) return null;
  // Nur den Datumsteil verwenden, Uhrzeit ignorieren
  const datePart = dateStr.split("T")[0];
  const parts = datePart.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  // Lokale Zeit (kein UTC-Shift)
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * FIX: Cache-Check korrekt getrennt von Page-ID-Prüfung.
 */
function getPageTitle(pageId) {
  if (!pageId) return null;
  // Aus Cache zurückgeben, falls vorhanden (auch leerer String ist gültig)
  if (projectCache[pageId] !== undefined) return projectCache[pageId];

  const url = `https://api.notion.com/v1/pages/${pageId}`;
  try {
    const res = UrlFetchApp.fetch(url, { "headers": notionHeaders, "muteHttpExceptions": true });
    const data = JSON.parse(res.getContentText());

    // API-Fehler abfangen
    if (data.object === "error") {
      console.error(`Notion API Fehler bei Seite ${pageId}: ${data.message}`);
      projectCache[pageId] = "Unbekanntes Projekt";
      return projectCache[pageId];
    }

    const titleProp = Object.values(data.properties).find(p => p.type === "title");
    const title = titleProp && titleProp.title.length > 0
      ? titleProp.title[0].plain_text
      : "Unbekanntes Projekt";

    projectCache[pageId] = title;
    return title;
  } catch (e) {
    console.error(`Fehler beim Abrufen von Seite ${pageId}: ${e}`);
    projectCache[pageId] = "Projekt Fehler";
    return projectCache[pageId];
  }
}

function updateNotionGoogleId(pageId, newId) {
  const url = `https://api.notion.com/v1/pages/${pageId}`;
  const payload = {
    "properties": {
      "Google ID": {
        "rich_text": [{ "text": { "content": newId || "" } }]
      }
    }
  };
  try {
    const res = UrlFetchApp.fetch(url, {
      "method": "patch",
      "headers": notionHeaders,
      "payload": JSON.stringify(payload),
      "muteHttpExceptions": true
    });
    const data = JSON.parse(res.getContentText());
    if (data.object === "error") {
      console.error(`Fehler beim Schreiben der Google ID für ${pageId}: ${data.message}`);
    }
  } catch (e) {
    console.error(`updateNotionGoogleId fehlgeschlagen für ${pageId}: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Haupt-Sync-Funktion
// ---------------------------------------------------------------------------

function syncDatabaseToCalendar(dbId, titleCol, dateCol, emoji, relationCol = null) {
  const calendar = CalendarApp.getDefaultCalendar();
  let hasMore = true;
  let startCursor = null;

  while (hasMore) {
    const url = `https://api.notion.com/v1/databases/${dbId}/query`;
    const requestPayload = startCursor ? { start_cursor: startCursor } : {};

    let data;
    try {
      const res = UrlFetchApp.fetch(url, {
        "method": "post",
        "headers": notionHeaders,
        "payload": JSON.stringify(requestPayload),
        "muteHttpExceptions": true
      });
      data = JSON.parse(res.getContentText());
    } catch (e) {
      console.error(`Fehler beim Abrufen der Datenbank ${dbId}: ${e}`);
      return;
    }

    // FIX: Notion API-Fehler frühzeitig abfangen
    if (data.object === "error") {
      console.error(`Notion API Fehler für DB ${dbId}: ${data.message}`);
      return;
    }

    const pages = data.results || [];
    hasMore = data.has_more || false;
    startCursor = data.next_cursor || null;

    for (let page of pages) {
      const props = page.properties;
      const title = extractNotionField(props[titleCol]);
      const dateStr = extractNotionField(props[dateCol]);
      const status = extractNotionField(props["Status"]);
      const googleId = extractNotionField(props["Google ID"]);
      const notionUrl = (page.url || "").trim();

      if (!title) continue;

      let projectSuffix = "";
      if (relationCol) {
        const relId = extractNotionField(props[relationCol]);
        if (relId) {
          const projectTitle = getPageTitle(relId);
          if (projectTitle) projectSuffix = ` (${projectTitle})`;
        }
      }

      const isDone = (status === "Erledigt" || status === "Veröffentlicht");
      const combinedTitle = `${emoji} ${title}${projectSuffix}`;

      // --- Status "Erledigt": Event löschen ---
      if (isDone) {
        if (googleId) {
          try {
            const event = calendar.getEventById(googleId);
            if (event) event.deleteEvent();
            updateNotionGoogleId(page.id, "");
            console.log(`🗑️ Erledigt, Event gelöscht: ${combinedTitle}`);
          } catch (e) {
            console.error(`Fehler beim Löschen von Event ${googleId}: ${e}`);
          }
        }
        continue;
      }

      // --- Datum vorhanden: Event erstellen oder aktualisieren ---
      if (dateStr) {
        // FIX: Lokales Datum-Parsing ohne UTC-Drift
        const eventDate = parseDateSafe(dateStr);
        if (!eventDate) {
          console.warn(`⚠️ Ungültiges Datum bei: ${combinedTitle} (Wert: "${dateStr}")`);
          continue;
        }

        // FIX: Bestehendes Event abrufen, null wenn manuell gelöscht oder ID fehlt
        let event = null;
        if (googleId) {
          try {
            event = calendar.getEventById(googleId);
          } catch (e) {
            console.warn(`Konnte Event ${googleId} nicht abrufen: ${e}`);
          }
        }

        if (!event) {
          // Neu erstellen (auch wenn ID vorhanden war, aber Event gelöscht wurde)
          try {
            console.log(`📅 Erstelle Event: ${combinedTitle}`);
            const newEvent = calendar.createAllDayEvent(combinedTitle, eventDate, { description: notionUrl });
            updateNotionGoogleId(page.id, newEvent.getId());
          } catch (e) {
            console.error(`Fehler beim Erstellen von Event "${combinedTitle}": ${e}`);
          }
        } else {
          // FIX: Datum-Vergleich über normalisierten String, nicht getTime()
          const oldDateStr = toDateString(event.getAllDayStartDate());
          const newDateStr = toDateString(eventDate);

          const needsUpdate =
            event.getTitle() !== combinedTitle ||
            oldDateStr !== newDateStr ||
            event.getDescription().trim() !== notionUrl;

          if (needsUpdate) {
            try {
              event.setTitle(combinedTitle);
              event.setAllDayDate(eventDate);
              event.setDescription(notionUrl);
              console.log(`🔄 Update: ${combinedTitle}`);
            } catch (e) {
              console.error(`Fehler beim Aktualisieren von Event "${combinedTitle}": ${e}`);
            }
          }
        }

      // --- Datum entfernt: Event löschen ---
      } else {
        if (googleId) {
          try {
            const event = calendar.getEventById(googleId);
            if (event) event.deleteEvent();
            updateNotionGoogleId(page.id, "");
            console.log(`🗑️ Datum entfernt, Event gelöscht: ${combinedTitle}`);
          } catch (e) {
            console.error(`Fehler beim Löschen von Event ${googleId}: ${e}`);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

function syncNotionCalendar() {
  // FIX: LockService verhindert parallele Ausführung bei Trigger-Überschneidung
  const lock = LockService.getScriptLock();
  const acquired = lock.tryLock(10000);
  if (!acquired) {
    console.warn("⚠️ Sync bereits aktiv, Ausführung abgebrochen.");
    return;
  }

  try {
    projectCache = {};
    syncDatabaseToCalendar(TODO_DB_ID, "ToDo", "Deadline", "✅", "Projekt");
    syncDatabaseToCalendar(POSTS_DB_ID, "Titel", "Geplant am", "✏️");
    console.log("✅ Sync abgeschlossen.");
  } finally {
    lock.releaseLock();
  }
}