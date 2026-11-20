SERVER PANEL
Run your own Minecraft servers from a web page or from your phone.
Works on Windows 10/11 and on Ubuntu / Debian.

WHAT IT DOES
  - Create servers: Vanilla, Fabric, Forge, NeoForge, Paper or Purpur, any version they support, or a Bedrock server (below).
    Give each one a name, a picture and the text shown in Minecraft's server list; add a required resource pack.
    Copy a server to make a second one.
  - Start, stop and restart, a live console (colours, old logs, crash reports, "share log" to mclo.gs),
    a daily restart time, stop a server by itself when nobody has been on for a while.
  - Players: whitelist, operators with levels, bans with a reason, banned addresses, and a "Cracked" switch (offline mode, like
    on Aternos: players without a bought Minecraft can join; the lists are converted). It works while the server is
    stopped too (names are looked up with Mojang).
  - Worlds: several worlds per server, switch between them, upload a world .zip, download a world as a .zip,
    make a new one (seed, type), data packs (upload or search Modrinth).
  - Mods (Fabric, Forge, NeoForge) and plugins (Paper, Purpur): upload them, or search and install from Modrinth
    (and from CurseForge, with your own free API key). Turn off, delete, see what needs a restart.
  - A file manager, world backups (by hand or on a schedule, with restore), all the usual server settings in groups.
  - Move a server here from Aternos (or anywhere else) with the .zip or .tar.gz files you download: the panel sees which software
    and Minecraft version it was, makes a new server like it and brings the world (with Nether and End), mods or plugins
    with their data, settings, player lists, name and picture.
  - Also: install a Modrinth modpack (.mrpack) as a new server; "Update all" for mods and plugins (checked on Modrinth);
    a live map (BlueMap); Bedrock players on your Java servers (Geyser + Floodgate on Paper, Purpur, Fabric and NeoForge); game rules; graphs of memory and players;
    start, stop and restart at set times every day; copy the tunnel address your friends use from outside next to the
    other join addresses; alerts to your phone (ntfy) or Discord when a server starts, stops, crashes or someone joins;
    an activity log of who did what (including who was let in); a health check on the Access tab (disk, memory, internet,
    each server) with a report you can copy; a copy of the panel's own settings and access list every day (the last 7
    days are kept in the "backup" folder next to servers.json).
  - Safer worlds: a backup is made by itself before a new Minecraft version is installed and before an imported world replaces the
    one you have. Every backup can also be copied to a folder (a USB drive, a network share) and to the cloud through rclone,
    so one dead disk does not take your worlds with it (Backups tab, owner only).
  - Speed: choose how much memory each server gets; a crashed server is started again by itself (up to 3 times in half an
    hour); "Is it laggy?" measures the real tick speed (spark, or the game's own command) and says what to try, and records
    60 seconds with spark; "Pre-generate the world" makes the land around the middle in advance with Chunky (Worlds tab).
  - Getting in: choose a password (the installer asks, or set-password.bat / "node set-password.js owner", or the Access tab):
    you type it once on each device and the device stays signed in for a year. Optionally a second "friends" password that
    only allows what you tick. Without a password, the first device becomes the owner with a one-time setup code and every
    other device asks and you say yes. Either way you choose what each person may do (start/stop, console, players,
    settings, backups and worlds, files, mods, creating servers), and on which servers. Add people by name (like on Aternos): you get a link that lets that one device straight in, and if they only type the name they wait for your tap. Or send an invite link. Take someone out and their device is locked out at once.
  - Bedrock servers: Mojang's own Bedrock Dedicated Server as one more choice when you create a server, for friends on phones,
    consoles and Windows 10/11 Bedrock. Start, stop, console, settings, allow list, worlds (a .mcworld goes in and out), backups
    that save the world safely while it runs, a live player count. The panel downloads the newest server from minecraft.net
    (Mojang keeps no older ones) and an update keeps your settings, allow list and worlds. Needs Windows, or Linux on a 64-bit
    Intel/AMD processor. No Java mods or plugins; the newest Bedrock server connects with one TCP and one UDP port (19132 and up,
    both opened for your home network and Tailscale by the installer: run the installer again if you updated the panel by hand).
    Joining: Minecraft Bedrock, Play, Servers, Add Server, with the address and the port the Overview shows.
  - An Android app that connects to your own panel (Server Panel app, same download page). It keeps a list of servers (the
    Servers button switches between them). An invite link you send opens the panel's sign-in page; on Android it has an
    "Open in the Server Panel app" button that adds that server to the app's list and signs the person in.
  - Java is downloaded for you, the right version for each Minecraft version. Every download is checked against the
    checksum its project publishes.

WHAT YOU NEED
  - A computer that stays on while people play (a spare laptop is fine). Plan on 2 GB of memory per server.
  - Windows 10 / 11, or Ubuntu / Debian with systemd.
  - Node.js 20 or newer. The installers offer to install it for you.
  - Nothing else. No account, nothing to pay, nothing is sent anywhere except the downloads above (and the log
    you choose to share).


INSTALL ON WINDOWS
  1. Unzip the whole download (right-click it, Extract All). Do not run the installer from inside the zip.
  2. Double-click install.bat.
     If Windows says "Windows protected your PC": More info, then Run anyway. (Or right-click the zip first,
     Properties, tick Unblock, OK, and unzip again.)
  3. Windows asks for permission once (the firewall). Say yes. Press Enter to skip the CurseForge question.
  4. The panel opens in your browser. Press "This computer is the owner", then "Create a server".
     Want a password instead? Double-click set-password.bat, type one (nothing shows while you type), and sign in with it
     on every device. "set-password.bat friends" sets a second password for friends.

  The panel starts by itself whenever you sign in to Windows, without a window. Your servers run as long as the panel
  does and are stopped properly when you shut down. Turn off sleep in the Windows power settings, a sleeping
  computer is not a server.
  Files: the panel is in %LOCALAPPDATA%\ServerPanel, your servers are in your user folder under minecraft-servers.
  The panel's log is %LOCALAPPDATA%\ServerPanel\panel.log.
  Update: unzip the new download and run install.bat again (stop your servers first; your settings and access stay).
  Forgot the password: set-password.bat sets a new one.   Lost the owner's device: install.bat -ResetAccess        CurseForge key: install.bat -SetCurseForgeKey
  Remove: uninstall.bat (your servers are kept).


INSTALL ON UBUNTU / DEBIAN
  tar xzf ServerPanel-Ubuntu-*.tar.gz
  cd server-panel
  bash install-panel.sh

  Run it as your normal user, not as root. It asks for your password (sudo) when it needs it, installs Node.js
  if it is missing, installs a systemd service so the panel starts at boot,
  and opens the firewall (if ufw is on) for the panel on your home network and Tailscale only, and for Minecraft ports.
  It offers to choose a password for the panel (Enter skips it); with a password, open the address and sign in. Without one,
  it prints a link with a one-time setup code: open it on the phone or computer that should be the owner.
  Later:  node ~/minecraft-panel/set-password.js owner   sets a new password (or use the Access tab).
  Your servers are systemd services too, so they survive the panel restarting and are stopped properly at shutdown.
  Files: the panel is in ~/minecraft-panel, your servers in ~/minecraft-servers.
  The log: journalctl -u minecraft-panel -f
  Update: run bash install-panel.sh again (it keeps your settings and who has access).
  Lost the owner's device: RESET_ACCESS=1 bash install-panel.sh    CurseForge key: SET_CURSEFORGE_KEY=1 bash install-panel.sh
  Settings you can change in /etc/minecraft-panel.env (then: sudo systemctl restart minecraft-panel):
    JAVA_HEAP_MB      memory per server in MB
    PANEL_MAX_RUNNING how many servers may run at the same time (default 1)
  Remove: the last line the installer prints tells you how.


OPEN THE PANEL, AND WHO GETS IN
  On the same computer:  http://localhost:8790
  From another device on your home network: the installer prints the addresses, for example http://192.168.1.20:8790
  Away from home: install Tailscale (free, tailscale.com) on the computer and on your phone; then use the computer's
  Tailscale address (100.x.x.x) instead. Do NOT forward port 8790 on your router and do not put the panel on the public
  internet: somebody with Files or Mods access can run programs on your computer (that is what uploading a mod means).

  There are no passwords. The first device becomes the owner (the setup code, or "This computer is the owner" on the
  computer itself). Any other device that opens the panel sees "Ask for access", the owner gets a badge on the
  Access tab and says yes, choosing what that person may do. Or make an invite link on the Access tab and send it.
  Only give Files, Mods and "Manage who has access" to people you would trust with the computer.

PHONE APP (ANDROID)
  Install ServerPanel-3.2.apk. On first start it asks for your server's address, for example 192.168.1.20 or the
  Tailscale address. You can save several servers (and several addresses for one server, tried in order: home first,
  then Tailscale). The first time, the app asks for access like any other device (or use your invite link).
  The app is the panel in a window plus file pickers and downloads.
  The panel talks plain http, so it only works on your home network or through Tailscale.

MOVING A SERVER FROM ATERNOS
  On aternos.org, open your server. On the Worlds page download the world; on the Files page select everything and
  download too (that is how you get mods, plugins and config). You get .zip files. In the panel open "Move a server
  here" and choose the zip. Aternos has no export for the rest and the panel never logs in to your Aternos account.
  Bedrock Edition worlds cannot be used (the panel runs Java Edition servers).
  Servers that ran without a bought Minecraft ("cracked") keep working if you tick "Keep offline mode".

LET FRIENDS JOIN
  On your home network they use the computer's address and the server's port (shown on the Overview tab).
  From outside: use a tunnel service such as playit.gg, or Tailscale (everyone installs it and you share the computer),
  or forward the server's port on your router (this shows your home address to everyone who joins, so think first).
  Each server has its own port (25565, 25566, ...). The panel never needs to be reachable from outside.

THINGS TO KNOW
  - Creating a server means you accept the Minecraft EULA (aka.ms/MinecraftEULA). The panel asks you to tick it.
  - New servers start with the whitelist on. Add players on the Players tab, or turn the whitelist off in Settings.
  - By default one server runs at a time, because every server needs its own memory. Raise PANEL_MAX_RUNNING if you can.
  - Windows: the servers stop when the panel stops. Linux: the panel is only the remote control.
  - Back up before you change software or version. "Change software" keeps the world but mods may not fit.
  - Not made by or affiliated with Mojang, Microsoft or Aternos. Minecraft is Mojang's trademark.

FREE TO USE AND SHARE. PROVIDED AS IT IS, WITHOUT ANY WARRANTY.
The fonts (DM Sans, Pixelify Sans) are under the SIL Open Font License, see panel/web/fonts/NOTICE.txt.
