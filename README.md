# La Bastide des Cœurs

Site institutionnel et présentation cinématique du projet **La Bastide des Cœurs** — premier foyer thérapeutique d'Occitanie pour enfants confiés par l'ASE — destiné à la Mairie d'Auterive (juin 2026).

- Porteuse : Abir Hayani
- Contact : labastidedescoeurs@gmail.com — 06 04 11 24 40
- Récépissé W313042177 (association loi 1901, avril 2026)

## Contenu du dépôt

| Chemin | Rôle |
|---|---|
| `presentation/index.html` | Présentation cinématique 15 scènes (HTML autonome, images base64 intégrées, navigation clavier/tactile, musique générative). Peut être ouvert tel quel dans n'importe quel navigateur moderne. |
| `scripts/render-video.mjs` | Rendu du HTML en vidéo MP4 (Puppeteer + ffmpeg, temps virtuel). |
| `scripts/fetch-music.sh` | Téléchargement de la piste musicale par défaut (CC BY 4.0). |
| `assets/music-attribution.md` | Crédit musical obligatoire. |
| `.github/workflows/render-video.yml` | Rendu reproductible dans GitHub Actions. |

## Voir la présentation

Ouvrir `presentation/index.html` dans Chrome ou Firefox.

- `→` / espace : scène suivante
- `←` : scène précédente
- `P` : pause / lecture
- `F` : plein écran

## Générer la vidéo MP4

### Localement

Pré-requis : **Node ≥ 20**, **ffmpeg**, et une connexion internet (Puppeteer télécharge Chromium au premier `npm install`, et le HTML charge des polices Google Fonts).

```sh
npm ci
./scripts/fetch-music.sh        # télécharge assets/music.mp3 (≈ 3 Mo)
npm run render                  # 4K / 30 fps -> output/bdc-auterive-4k.mp4
```

Variantes utiles :

```sh
npm run render:1080p            # 1920x1080, plus rapide
npm run render:preview          # 1280x720 / 15 fps, ~1 minute (itération rapide)

# Custom :
node scripts/render-video.mjs --width 2560 --height 1440 --fps 30
node scripts/render-video.mjs --audio assets/autre-musique.mp3
node scripts/render-video.mjs --output output/version-courte.mp4 --duration 90
```

Le rendu 4K complet prend environ **10–25 min** selon la machine. La sortie est un MP4 H.264 + AAC, ≈ 80–200 Mo.

### Via GitHub Actions

Onglet **Actions** → **Render video** → **Run workflow**. Les paramètres (résolution, fps) sont éditables au lancement. La vidéo est disponible en artifact téléchargeable à la fin du job.

## Changer la musique

La piste par défaut (*Reverie (small theme)* de Kevin MacLeod, CC BY 4.0) est téléchargée par `scripts/fetch-music.sh`. Voir `assets/music-attribution.md` pour le crédit obligatoire à mentionner lors de la diffusion.

Pour utiliser une autre piste : déposez votre fichier à `assets/music.mp3` (n'importe quel format audio lisible par ffmpeg fonctionne — renommez-le simplement) ou passez `--audio chemin/vers/piste.mp3` à la commande de rendu. Si aucun fichier audio n'est trouvé, la vidéo est rendue muette.

## Comment ça marche (rendu)

Le script `scripts/render-video.mjs` lance Chromium en headless via Puppeteer, puis **patche toutes les primitives temporelles de la page** (`Date.now`, `performance.now`, le constructeur `Date`, `setTimeout`, `setInterval`, `requestAnimationFrame`) pour que le temps soit piloté frame par frame depuis Node. À chaque image :

1. Avance le temps virtuel de `1000/fps` ms.
2. Déclenche les timers échus (la `setInterval` du diaporama avance les scènes).
3. Repositionne toutes les animations CSS (`document.getAnimations()`) au temps voulu — les transitions ken-burns restent fluides et déterministes.
4. Capture un PNG et le pipe sur l'entrée standard d'un unique processus `ffmpeg`, qui assemble le flux vidéo et muxe la piste audio.

L'`AudioContext` interne du HTML est neutralisé pour éviter toute synthèse parasite — la musique du MP4 vient exclusivement de `assets/music.mp3`.
