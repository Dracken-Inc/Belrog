# Release Notes — Belrog 0.5.1

Small release. It takes one feature out, fixes a connection problem, and finishes
renaming leftovers from the merge.

## GPU sharing is gone

GPU sharing was Belrog's old online service that ran your work on someone else's
computer. It belonged to the online product, not to Belrog, so it's removed end
to end:

- The **GPU sharing** tab is gone from the top bar. If you had hidden it, nothing
  changes — Belrog forgets the old setting on its own.
- The phone companion no longer offers shared-GPU actions. Phones that are
  already paired keep working; they just don't show the option.
- Things you make are filed under **Visuals** and **Sound** in the Assets panel.
  The separate GPU sharing folder is gone.
- Settings no longer lists "Share your GPU".

What stays: signing in, your paired phone, your Luna balance, and cloud
generation through the Router. Those are separate features.

If you have work still sitting in a shared queue from an older version, it won't
run here. Save the workflow to your library first, then generate locally or
through the cloud.

## Remote ComfyUI connects when port 8188 is busy

If ComfyUI already runs on the machine you're connecting from, the tunnel used to
die with "Port 8188 is already in use" and you'd have to shut one of them down.
It now picks the next free port, and generation follows the port that actually
connected instead of the number in your settings — so it can't quietly talk to
the wrong ComfyUI. A tunnel that dropped no longer stays half-open until restart.

## Cast finds missing coverage again

The Cast panel stopped flagging shots with no coverage because its gap detector
was never connected after the merge. It's connected, so gaps show up in the panel
the way they did before.

## Naming

Leftover "Velorn" text is now Belrog: the app window title, the Discord release
notices, the caption-engine download notes, and the frame-interpolation helper's
own status text.

## Testing

Unit tests that live next to the code they cover now run on every release, both
locally (`npm run test:co-located`) and in the release build. They used to run
for nobody, which is how the Cast problem above shipped.
