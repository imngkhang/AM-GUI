# AM-GUI — Notes du dépôt

> Fichier de sauvegarde de la mémoire du dépôt (Copilot).
> En cas de reset de VSCodium, copier ce contenu vers `/memories/repo/AM-GUI.md` pour restaurer la mémoire.
> ⚠️ Les deux fichiers (`AM-GUI.dev-notes.md` et `/memories/repo/AM-GUI.md`) doivent toujours rester synchronisés.

## Rôle
Frontend graphique Electron pour l'outil **AM** (ivan-hc) : installer, mettre à jour et gérer les AppImages et formats portables sur Linux.

## Stack
- Electron ^43, node-pty, @xterm/xterm + addon-fit, undici
- Tests : runner natif Node (`node --test`), jsdom pour le renderer
- Lint : ESLint 9

## Commandes
- `npm start` → `electron . --gtk-version=3`
- `npm test` / `npm run test:main` / `test:renderer` / `test:integration`
- `npm run lint` → `eslint main.js preload.js src/**/*.js`
- `npm run dist` → `electron-builder --linux dir`
- `npm run build:i18n` → `node src/i18n/build-i18n.js` (régénère translations.js depuis locales/*.json)

## Architecture
- `main.js` : point d'entrée Electron ; `preload.js` : pont IPC
- `src/main/` : processus principal — appList, appManAuto, categories, gpu, iconCache, install, packageManager, sandbox, tray, uninstall, updates
- `src/renderer/` : renderer — `features/` (appLoader, categories, details, featured, installer, sandbox, search, updates), `services/preferences.js`, `ui/` (confirmModal, lightbox, passwordPrompt, settingsPanel, syncButton, toast, virtualList), `utils/`
- `src/i18n/` : `locales/*.json` (source de vérité, 4 sections ui/tray/contextMenu/errors) → `build-i18n.js` génère `translations.js` (ne pas éditer à la main) ; `README.md` pour les traducteurs ; `pla-fetch.js` = module UMD partagé main/renderer (fetch site PLA avec préfixe langue + fallback en)
  - **Pourquoi JSON et pas `.po`/`.xliff`** (décision issue #74) : le renderer n'a AUCUNE étape de build (balises `<script>` simples, pas de bundler). `.po`/`.xliff` demanderaient un parseur runtime ou un build step. Le JSON donne la plupart des bénéfices des outils de traduction (Crowdin/Weblate/Poedit importent le JSON) sans build step. Migration vers `.po` possible plus tard en échangeant juste le format source + adaptant le générateur (les traducteurs ne verraient pas la différence).
- `src/assets/tray/` : icônes tray (extraResources du build)
- `test/` : main / renderer / integration

## Protocole pla-install:// (bouton « Install » du site PLA)
- Le site PLA (Portable-Linux-Apps) envoie `pla-install://<appname>` quand on clique sur Install.
- Implémenté : `src/main/plaInstall.js` (parse/extract), `main.js` (setAsDefaultProtocolClient + second-instance + open-url + did-finish-load), `preload.js` (`onPlaInstall`), `renderer.js` (ouvre les détails + confirmation via `confirmModal.openActionConfirm` puis `enqueueInstall`), `package.json` (build.protocols), `AM-GUI.desktop` (MimeType=x-scheme-handler/pla-install;).
- Tests : `test/main/plaInstall.test.js`.

## Divers
- `start-am-gui.sh`, `appimage-build/get-dependencies.sh`, `appimage-build/make-appimage.sh`
- Build AppImage via le template pkgforge (Anylinux-AppImages)
- Fichier de cache des catégories : `categories-cache.json`
- **Sync langue AM/AppMan (opt-in)** : checkbox `settings.syncAmLocale` (localStorage `syncAmLocale`) → au changement de langue, IPC `sync-am-locale` → `translatePackageManagerLocale()` dans `packageManager.js` (exécute `<pm> translate <code>`, timeout 60 s, AM ≥ 9.8). ⚠️ Modifie la config d'AM de l'utilisateur (sort du mode auto).

## Portail PLA — format JSON (site réécrit, 2026) + préfixe langue (2026-09)
- ⚠️ **Toutes les URLs publiées sont préfixées par langue** : `/<lang>/…` (le site supporte `en` et `it`).
  - Les anciennes URLs sans préfixe renvoient **404**.
  - AM-GUI construit l'URL avec la langue de l'UI, avec **fallback automatique sur `en/`** en cas de 404/erreur
    (`fetchPla()` dans `src/main/categories.js` et `src/renderer/features/details/index.js`).
    → **Aucune liste de langues à maintenir** : une nouvelle langue AM-GUI fonctionne automatiquement
    (servie si le site la supporte, sinon repli sur en).
  - Langue côté main : `getCurrentLocale()` (translations.js, sync via IPC `set-tray-locale`) ; côté renderer : `window.getLangPref` (exposé par renderer.js).
  - **Descriptions des tuiles** : les JSON de catégories contiennent `{ appName: { description, archs } }` → le main conserve les descriptions (`appsFromCategoryJson` → `{ apps, descriptions }`) et le renderer enrichit les tuiles via `state.categoryDesc` (wrapper `setAppList`). Au changement de langue, le renderer purge le cache des catégories et refetch dans la nouvelle langue.
  - **Cache des catégories** : nouveau format `{ lang, categories }` (ancien format tableau migré à la volée, lang = null). Le renderer compare la langue du cache à la langue courante : si elle diffère, il force le refresh même si la liste d'apps est identique (sinon les descriptions traduites ne seraient jamais appliquées).
- Descriptions : `https://portable-linux-apps.github.io/<lang>/app/<nom>.json`
  - champs : `name`, `description` (markdown), `screenshots` (chemins relatifs `../../screenshots/…`), `sites`, `sources`, `buttons` (`"Label::URL"`, `_` = espace)
  - champs optionnels (PR #192 mergé 2026-08-24) : `archived` (bool), `obsolete` (u16 = année) → badge dans les détails
  - wording badge neutre (aligné AM qui affiche `is ARCHIVED` / `of <year>`) : `details.archived` = « Source archivée », `details.obsolete` = « Pas de mise à jour depuis {year} »
  - géré dans `src/renderer/features/details/index.js` (`loadRemoteDescription`)
- Catégories : `https://portable-linux-apps.github.io/<lang>/categories/<nom>.json`
  - objet `{ appName: { description, archs } }`, apps = `Object.keys(json)`
  - liste des noms extraite de `https://portable-linux-apps.github.io/<lang>/index.html` (regex `class="category-link" href="…html"`, 34 catégories).
    ⚠️ L'ancien `cat_page.in` est devenu un **template de page** (variables `$LANG`, `$CAT_NAME`) : ne plus l'utiliser.
  - géré dans `src/main/categories.js`
- Icônes : inchangées — `https://raw.githubusercontent.com/Portable-Linux-Apps/Portable-Linux-Apps.github.io/main/icons/<nom>.png` (pas de préfixe langue).
- Liste complète : `https://portable-linux-apps.github.io/<lang>/apps.json` (même format que categories, ~3500 apps).
  - ⚠️ NE PAS l'utiliser pour remplacer `am -l` dans `appList.js` : elle n'a que `description`+`archs` (pas installé/version/scope/diamond) et ajouterait un fetch réseau au démarrage. `am -l` local + cache reste mieux.
- Ancien format `.md` (racine du dépôt PLA + `apps/<nom>.md`) : supprimé.

## Pièges
- `.content` : ne jamais mettre `overflow-x: hidden` → transforme `overflow-y` en `auto` et fait de `.content` le vrai scrolleur (à la place de `.scroll-shell`), ce qui casse le reset du scroll au changement d'onglet. Utiliser `overflow-x: clip`.

- Le reset scroll (`scrollShell.scrollTop = 0`) ne fonctionne que si `.scroll-shell` est bien l'élément scrollant.
## Debug
- Lancer l'app avec CDP pour inspecter le vrai DOM :
  `./node_modules/electron/dist/electron . --gtk-version=3 --remote-debugging-port=9223 --user-data-dir=/tmp/amgui-cdp`
  puis `curl http://127.0.0.1:9223/json` → se connecter via WebSocket (Node ≥22 a `WebSocket` global) → `Runtime.evaluate`.
- Pour un bug de scroll : vérifier QUEL élément scrolle réellement (`scrollHeight` vs `clientHeight` + `getComputedStyle(el).overflowY`), ne pas supposer que c'est `.scroll-shell`.
