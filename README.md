# Plan de course

Site statique (GitHub Pages) qui construit un plan d'entraînement de course à pied à partir d'un objectif (5 km, 10 km, demi-marathon, marathon + date de la course), puis sert à suivre les séances : crochet vert quand c'est fait, stats recopiées de Strava, résultat de la course.

## Comment ça marche

- Aucune donnée dans ce dépôt. Chaque personne garde son plan dans **son propre dépôt privé** GitHub (`<son-compte>/journal-course`, fichier `course.json`).
- Le site lit et écrit ce fichier avec un jeton « fine-grained » (permission *Contents : Read and write* sur ce seul dépôt), gardé dans le navigateur (`localStorage`, clés `jc_*`).
- Les instructions de connexion sont affichées sur la page d'accueil tant qu'on n'est pas connecté.

## Le plan

Généré dans le navigateur (`generatePlan` dans `app.js`), semaines calées sur le jour de la course :

- phases Base → Développement → Spécifique → Affûtage → Course ;
- volume hebdomadaire qui monte d'au plus ~10 % par semaine, une semaine allégée sur quatre ;
- sortie longue progressive (+2 km au plus), séances de qualité selon la phase (fartlek, seuil, intervalles, allure course) ;
- allures calculées à partir d'une performance récente ou du temps visé (formule de Riegel), sinon consignes aux sensations ;
- ajustement automatique (`evaluate` / `autoAdjust`) : selon les séances entrées (allure, distance, ressenti, séances manquées), les allures et le volume des séances à venir sont recalculés ; chaque ajustement est affiché et annulable, et le réglage se coupe dans Compte.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Objectif, plan semaine par semaine, crochet « complétée », stats d'une séance |
| `stats.html` | Tuiles, km prévus / courus par semaine (Chart.js), séances complétées, résultat de la course |
| `app.js` | Connexion GitHub, synchronisation (fusion par enregistrement), générateur de plan, calculs |
| `style.css` | Styles, mode sombre automatique |
| `sw.js`, `manifest.webmanifest`, `icon*.png/svg` | Installation comme application, hors ligne |

## Mise en ligne

Settings → Pages → *Deploy from a branch* → `main` / `(root)`.
