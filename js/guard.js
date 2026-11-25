// Gestionnaires d'événements (clics) dont l'action est asynchrone. (Ni DOM, ni `grist` : testé à part.)
//
// Une action qui échoue rend une promesse rejetée, que le gestionnaire d'un clic laisse partir sans la lire. Vérifié (audit du
// 25 novembre 2026, vrai Grist) : un refus de `grist.docApi` (« Blocked by table structure access rules » pour un éditeur sans
// droit de structure) ne déclenche PAS l'événement `unhandledrejection` du navigateur, donc un simple écouteur global ne le
// verrait jamais, et la personne cliquait sur « Arrêter la réception » sans rien lire. Chaque gestionnaire posé par `el`
// (js/ui.js) passe donc par `guarded` : s'il rend une promesse qui échoue, l'erreur est rapportée (filet de js/safety-net.js).
// Les actions qui ont leur message à l'endroit du bouton (`run` de js/ui.js) ne rejettent jamais : rien ne change pour elles.
let report = error => console.error(error);

// Qui reçoit l'erreur d'un gestionnaire dont l'action a échoué (posé par installSafetyNet).
export const setUncaughtReporter = fn => { report = fn; };

export function guarded(handler) {
  if (typeof handler !== 'function') return handler;
  return function guardedHandler(...args) {
    const out = handler.apply(this, args);
    if (out && typeof out.then === 'function') out.then(undefined, reason => report(reason));
    return out;
  };
}
