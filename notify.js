// Envoie une notification aux élèves dont un résultat vient d'être ajouté ou modifié.
// Tourne gratuitement via GitHub Actions (aucun forfait Firebase payant nécessaire).
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

// SEED=oui : on mémorise l'état actuel SANS envoyer de notification (premier lancement)
const seed = process.env.SEED === "oui";

// Seuls les appareils enregistrés depuis cette adresse reçoivent les notifications
const ORIGINE = "https://classeo.legroupeg.fr";

const dejaNotifies = new Set();   // évite les doublons pendant un même passage

async function envoyer(code){
  dejaNotifies.add(code);
  const snap = await db.collection("tokens").where("eleve", "==", code).get();
  const docs = snap.docs.filter(d => d.data().origine === ORIGINE);
  if (docs.length === 0) { console.log(`- ${code} : aucun appareil enregistré sur ${ORIGINE}`); return; }

  const res = await admin.messaging().sendEachForMulticast({
    tokens: docs.map(d => d.id),
    data: { title: "Classeo", body: "Tes résultats sont disponibles !" },
    webpush: { headers: { TTL: "86400", Urgency: "high" } }
  });
  console.log(`- ${code} : ${res.successCount} envoyée(s), ${res.failureCount} échec(s)`);

  // Supprime les appareils qui ne sont plus valides
  const batch = db.batch();
  res.responses.forEach((r, i) => {
    const c = r.error && r.error.code;
    if (c === "messaging/registration-token-not-registered" ||
        c === "messaging/invalid-registration-token") {
      batch.delete(docs[i].ref);
    }
  });
  await batch.commit();
}

(async () => {
  const eleves = await db.collection("eleves").get();
  console.log(`${eleves.size} élève(s) vérifié(s)${seed ? " (mode initialisation)" : ""}`);

  for (const d of eleves.docs) {
    const data = d.data();
    const ref = db.collection("notified").doc(d.id);
    const prev = (await ref.get()).data() || {};

    const maj = {};
    let nouveau = false;
    for (const t of ["T1", "T2", "T3"]) {
      const txt = data[t] || "";
      if (txt !== (prev[t] || "")) maj[t] = txt;
      if (txt && txt !== prev[t]) nouveau = true;
    }
    if (Object.keys(maj).length === 0) continue;

    try {
      if (nouveau && !seed) await envoyer(d.id);
      await ref.set(maj, { merge: true });   // mémorisé seulement si l'envoi n'a pas planté
    } catch (e) {
      console.error(`Erreur pour ${d.id} :`, e.message);
      process.exitCode = 1;
    }
  }

  // Demandes manuelles faites depuis l'onglet admin (bouton « Notifier »)
  if (!seed) {
    const cmds = await db.collection("commandes").where("traite", "==", false).get();
    console.log(`${cmds.size} demande(s) manuelle(s)`);
    for (const c of cmds.docs) {
      try {
        const cible = c.data().cible;
        const codes = cible === "tous" ? eleves.docs.map(x => x.id) : [cible];
        for (const code of codes) {
          if (!dejaNotifies.has(code)) await envoyer(code);
        }
        await c.ref.update({ traite: true, traiteLe: Date.now() });
      } catch (e) {
        console.error("Erreur demande manuelle :", e.message);
        process.exitCode = 1;
      }
    }
  }
})();
