# Stream Chat Overlay

Fenêtre flottante toujours au-dessus qui centralise le chat Twitch et YouTube en temps réel. Transparence OS 80%, son sur nouveau message, emotes Twitch, compteurs de viewers.

## Prérequis

- [Bun](https://bun.sh)
- Chromium
- `xdotool` et `xprop` (pour always-on-top et transparence sous GNOME/XWayland)

```bash
sudo pacman -S xdotool xorg-xprop   # Arch
sudo apt install xdotool x11-utils  # Debian/Ubuntu
```

## Installation

```bash
git clone https://github.com/sepiropht/stream-chat-overlay
cd stream-chat-overlay
cp config.example.json config.json
```

Ajouter la commande au PATH (optionnel) :

```bash
ln -sf "$PWD/launch.sh" ~/.local/bin/stream-chat
chmod +x launch.sh
```

## Configuration

Édite `config.json` :

```json
{
  "twitch": {
    "channel": "ta_chaine_twitch",
    "clientId": "",
    "clientSecret": ""
  },
  "youtube": {
    "apiKey": "AIza...",
    "videoId": ""
  }
}
```

### Twitch (chat uniquement)

Le chat Twitch fonctionne sans clé API — il suffit de renseigner `channel`.

Pour le **compteur de viewers**, crée une application sur [dev.twitch.tv/console](https://dev.twitch.tv/console) :
1. New App → type "Other"
2. Copie le **Client ID** et génère un **Client Secret**
3. Renseigne `clientId` et `clientSecret` dans `config.json`

### YouTube

1. Va sur [console.cloud.google.com](https://console.cloud.google.com)
2. Active l'API **YouTube Data API v3**
3. Credentials → Create Credentials → **API Key**
4. Renseigne `apiKey` dans `config.json`
5. Renseigne `videoId` avec l'ID de ta vidéo live (ex: `McRGl9KBA3M` depuis `youtube.com/watch?v=McRGl9KBA3M`)

> **Quota** : l'API YouTube offre 10 000 unités/jour. Le polling est limité à 20s minimum pour éviter de l'épuiser (~2 000 appels/jour max).

## Lancement

```bash
stream-chat
# ou directement :
bash /chemin/vers/stream-chat/launch.sh
```

La fenêtre s'ouvre automatiquement, épinglée au-dessus de toutes les autres avec 80% de transparence.

La configuration peut aussi être modifiée depuis l'interface (icône ⚙️) sans redémarrer le serveur.

## Notes

- Les 80 derniers messages sont sauvegardés localement dans `.msg-buffer.json` et réaffichés au redémarrage
- Le serveur tourne sur `http://localhost:7432`
- Fonctionne sous GNOME avec XWayland (`--ozone-platform=x11`)
