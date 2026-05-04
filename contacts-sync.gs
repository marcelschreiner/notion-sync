const notionHeaders = {
  "Authorization": `Bearer ${NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json"
};

const infinityHeaders = {
  "x-api-token": INFINITY_TOKEN,
  "Content-Type": "application/json"
};

// Puffer gegen Trigger-Ausfälle: 25h statt 24h
const SYNC_WINDOW_HOURS = 25;

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function extractValue(prop) {
  if (!prop) return "";
  const pType = prop.type;
  if (pType === "title" || pType === "rich_text") {
    return prop[pType] && prop[pType].length > 0 ? prop[pType][0].plain_text : "";
  } else if (pType === "email" || pType === "phone_number" || pType === "url") {
    return prop[pType] || "";
  } else if (pType === "select") {
    return prop.select ? prop.select.name : "";
  }
  return "";
}

function updateNotionId(pageId, fieldName, newId) {
  if (!newId) {
    console.warn(`   ⚠️ updateNotionId aufgerufen mit leerem Wert für "${fieldName}" — übersprungen.`);
    return;
  }
  const url = `https://api.notion.com/v1/pages/${pageId}`;
  const payload = { "properties": {} };
  payload.properties[fieldName] = { "rich_text": [{ "text": { "content": newId } }] };

  try {
    const res = UrlFetchApp.fetch(url, {
      "method": "patch",
      "headers": notionHeaders,
      "payload": JSON.stringify(payload),
      "muteHttpExceptions": true
    });
    const data = JSON.parse(res.getContentText());
    if (data.object === "error") {
      console.error(`   ❌ Notion Fehler beim Schreiben von "${fieldName}": ${data.message}`);
    } else {
      console.log(`   ↳ ${fieldName} (${newId}) in Notion gespeichert.`);
    }
  } catch (e) {
    console.error(`   ❌ updateNotionId fehlgeschlagen für "${fieldName}": ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Notion: Geänderte Kontakte mit Zeitfenster-Filter laden (+ Paginierung)
// ---------------------------------------------------------------------------

function fetchAllNotionContacts() {
  const contacts = [];
  let hasMore = true;
  let startCursor = null;

  // FIX (Gemini-Idee): Nur kürzlich geänderte Einträge laden
  // FIX: 25h statt 24h als Puffer gegen Trigger-Ausfälle
  const since = new Date(Date.now() - SYNC_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  console.log(`Suche nach Änderungen seit: ${since}`);

  while (hasMore) {
    const url = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;
    const requestPayload = {
      filter: {
        timestamp: "last_edited_time",
        last_edited_time: { on_or_after: since }
      }
    };
    if (startCursor) requestPayload.start_cursor = startCursor;

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
      console.error(`Fehler beim Abrufen der Notion-Datenbank: ${e.message}`);
      return contacts;
    }

    if (data.object === "error") {
      console.error(`Notion API Fehler: ${data.message}`);
      return contacts;
    }

    contacts.push(...(data.results || []));
    hasMore = data.has_more || false;
    startCursor = data.next_cursor || null;
  }

  return contacts;
}

// ---------------------------------------------------------------------------
// Infinity Swiss Sync
// ---------------------------------------------------------------------------

function syncInfinity(pageId, infId, infData, label) {
  // Leere Strings entfernen (nur echte Strings, keine booleans/numbers)
  Object.keys(infData).forEach(key => {
    if (typeof infData[key] === "string" && infData[key] === "") delete infData[key];
  });

  try {
    if (!infId) {
      const res = UrlFetchApp.fetch("https://api.infinity.swiss/v1/contacts", {
        "method": "post",
        "headers": infinityHeaders,
        "payload": JSON.stringify(infData),
        "muteHttpExceptions": true
      });
      const code = res.getResponseCode();
      if (code === 200 || code === 201) {
        const body = JSON.parse(res.getContentText());
        const newInfId = body.contact?.id;
        if (newInfId) {
          updateNotionId(pageId, "Infinity ID", newInfId);
        } else {
          console.warn(`   ⚠️ Infinity gab keine ID zurück für "${label}": ${res.getContentText()}`);
        }
      } else {
        console.error(`   ❌ Infinity POST fehlgeschlagen (${code}) für "${label}": ${res.getContentText()}`);
      }
    } else {
      // FIX: PATCH Response prüfen (von Gemini weggelassen)
      const res = UrlFetchApp.fetch(`https://api.infinity.swiss/v1/contacts/${infId}`, {
        "method": "patch",
        "headers": infinityHeaders,
        "payload": JSON.stringify(infData),
        "muteHttpExceptions": true
      });
      const code = res.getResponseCode();
      if (code !== 200 && code !== 204) {
        console.error(`   ❌ Infinity PATCH fehlgeschlagen (${code}) für "${label}": ${res.getContentText()}`);
      }
    }
  } catch (e) {
    console.error(`   ❌ Infinity Fehler für "${label}": ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Google Contacts Sync
// ---------------------------------------------------------------------------

function syncGoogle(pageId, googleId, googlePayload, label) {
  const fields = "names,emailAddresses,phoneNumbers,organizations,biographies,addresses,urls";

  try {
    if (!googleId) {
      const created = People.People.createContact(googlePayload);
      updateNotionId(pageId, "Google ID", created.resourceName);
    } else {
      // FIX: People.get() hat eigenen try/catch (von Gemini weggelassen)
      let existing;
      try {
        existing = People.People.get(googleId, { personFields: fields });
      } catch (e) {
        console.error(`   ❌ Google Kontakt abrufen fehlgeschlagen für "${label}" (${googleId}): ${e.message}`);
        return;
      }

      // FIX: etag prüfen bevor Update (von Gemini weggelassen)
      if (!existing.etag) {
        console.error(`   ❌ Kein etag für Google-Kontakt "${label}" — Update übersprungen.`);
        return;
      }

      googlePayload.etag = existing.etag;
      People.People.updateContact(googlePayload, googleId, { updatePersonFields: fields });
    }
  } catch (e) {
    console.error(`   ❌ Google Fehler für "${label}": ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Haupt-Sync
// ---------------------------------------------------------------------------

function syncAllContacts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.warn("⚠️ Sync bereits aktiv, Ausführung abgebrochen.");
    return;
  }

  try {
    const contacts = fetchAllNotionContacts();

    if (contacts.length === 0) {
      console.log(`Keine Änderungen in den letzten ${SYNC_WINDOW_HOURS}h gefunden.`);
      return;
    }

    console.log(`Synchronisiere ${contacts.length} geänderte Kontakte...`);

    for (let i = 0; i < contacts.length; i++) {
      const props = contacts[i].properties;
      const pageId = contacts[i].id;
      const notionUrl = contacts[i].url || "";

      const firstName     = extractValue(props["Vorname"]);
      const lastName      = extractValue(props["Nachname"]);
      const email         = extractValue(props["E\u2011Mail"]); // U+2011 Non-Breaking Hyphen
      const company       = extractValue(props["Firmenname"]);
      const phone         = extractValue(props["Telefon"]);
      const mobile        = extractValue(props["Mobil"]);
      const position      = extractValue(props["Position"]);
      const website       = extractValue(props["Webseite"]);
      const street        = extractValue(props["Strasse"]);
      const building      = extractValue(props["Hausnummer"]);
      const city          = extractValue(props["Ort"]);
      const zip           = extractValue(props["PLZ"]);
      const country       = extractValue(props["Land"]);
      const addressLine2  = extractValue(props["Adresszeile 2"]);
      const formOfAddress = extractValue(props["Anrede"]);
      const vat           = extractValue(props["MwSt-Nummer"]);
      const customerId    = extractValue(props["Kundennummer"]);
      const googleId      = extractValue(props["Google ID"]);
      const infId         = extractValue(props["Infinity ID"]);

      if (!firstName && !lastName && !company) continue;

      const label = [firstName, lastName || company].filter(Boolean).join(" ");
      console.log(`Verarbeite (${i + 1}/${contacts.length}): ${label}...`);

      let baseNote = `Notion Link: ${notionUrl}`;
      if (vat) baseNote += `\nMwSt: ${vat}`;
      if (customerId) baseNote += `\nKunden-Nr: ${customerId}`;

      // Infinity Sync
      const infData = {
        companyName: company, firstName: firstName, lastName: lastName,
        streetName: street, buildingNumber: building, townName: city,
        postCode: zip, position: position, email: email, mobile: mobile,
        phone: phone, website: website, category: "clients",
        formOfAddress: formOfAddress, note: baseNote, vatNumber: vat,
        country: country, secondaryAddressLine: addressLine2,
        customerIdentification: customerId
      };
      syncInfinity(pageId, infId, infData, label);

      // Google Sync
      const familyName = lastName
        ? `${lastName} (biz)`
        : company ? `${company} (biz)` : "(biz)";

      const googlePayload = {
        names: [{ givenName: firstName || company, familyName: familyName }],
        biographies: [{ value: baseNote }]
      };
      if (email) googlePayload.emailAddresses = [{ value: email, type: "work" }];
      const phones = [];
      if (phone)  phones.push({ value: phone,  type: "work" });
      if (mobile) phones.push({ value: mobile, type: "mobile" });
      if (phones.length > 0) googlePayload.phoneNumbers = phones;
      if (company || position) googlePayload.organizations = [{ name: company, title: position }];
      if (website) googlePayload.urls = [{ value: website }];

      const streetAddress = [street, building].filter(Boolean).join(" ");
      if (streetAddress || city || zip || country) {
        const addr = {
          streetAddress: streetAddress,
          city: city,
          postalCode: zip,
          country: country,
          type: "work"
        };
        if (addressLine2) addr.extendedAddress = addressLine2; // FIX: kein leerer String
        googlePayload.addresses = [addr];
      }

      syncGoogle(pageId, googleId, googlePayload, label);
    }

    console.log("✅ Sync abgeschlossen.");
  } finally {
    lock.releaseLock();
  }
}
