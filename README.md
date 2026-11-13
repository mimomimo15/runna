# Plan de course

Site statique (GitHub Pages) qui construit un plan d'entraînement de course à pied à partir d'un objectif (5 km, 10 km, demi-marathon, marathon + date de la course), puis sert à suivre les séances : crochet vert quand c'est fait, stats recopiées de Strava, résultat de la course.

## Comment ça marche

- Aucune donnée dans ce dépôt. Chaque personne garde son plan dans **son propre dépôt privé** GitHub (`<son-compte>/journal-course`, fichier `course.json`).
- Le site lit et écrit ce fichier avec un jeton « fine-grained » (permission *Contents : Read and write* sur ce seul dépôt), gardé dans le navigateur (`localStorage`, clés `jc_*`).
- Les instructions de connexion sont affichées sur la page d'accueil tant qu'on n'est pas connecté.

## Strava (facultatif)

Une fois Strava connecté (onglet Compte), coller le lien d'une activité dans les stats d'une séance remplit la distance, le temps, la fréquence cardiaque, le dénivelé et la note.

- Strava n'ouvre ses données qu'avec une autorisation : chaque personne crée sa propre application API sur <https://www.strava.com/settings/api>, avec le domaine du site comme *Authorization Callback Domain*, puis l'autorise une fois (`stravaStart` / `stravaFinish` dans `app.js`).
- L'ID et le secret de cette application et le jeton de renouvellement sont gardés dans le dépôt privé (enregistrement `strava` de `course.json`), pour que la connexion suive tous les appareils. Le jeton d'accès, valable quelques heures, reste dans le navigateur (`jc_strava_tok`).
- Accès en lecture seule (`activity:read`, ou `activity:read_all` si on inclut les activités « Moi uniquement »). « Déconnecter Strava » révoque l'accès chez Strava et efface l'enregistrement.
- Lien complet (`strava.com/activities/…`) : l'activité est lue par son numéro. Lien court de l'app mobile (`strava.app.link/…`) : si le navigateur ne peut pas le suivre, c'est la course à pied du jour de la séance qui est prise.
- Temps repris : temps en mouvement pour une séance, temps écoulé pour la course.

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
| `fonts/instrument-sans.woff2` | Police de l'interface (Instrument Sans, licence SIL OFL 1.1), servie depuis le dépôt |
| `sw.js`, `manifest.webmanifest`, `icon*.png/svg` | Installation comme application, hors ligne |

## Mise en ligne

Settings → Pages → *Deploy from a branch* → `main` / `(root)`.
