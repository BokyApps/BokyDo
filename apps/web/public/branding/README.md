# BokyDo mark

`bokydo-mark-v1.png` is the transparent source artwork; `bokydo-mark-small.png` is its
256px web export. The web/PWA tiles, Android adaptive foreground and store icon derive from
this source. The charcoal tile background is `#24211e`. Keep the wordmark in JetBrains Mono,
independently of the user's selected font. The adaptive mark fits inside the central safe area.

Created with the built-in imagegen tool. Final prompt:

> Use case: logo-brand. Create a single polished app icon / brand symbol for BokyDo, an
> open-source personal todo and habit tracker. Icon only, no lettering or wordmark. A distinctive
> bold geometric orange B monogram with a clean checkmark cut into its lower bowl, combining the
> initial B and completing a task into one compact recognizable silhouette. Simple flat
> vector-like shapes with balanced softly rounded geometry, crisp clean edges, no gradients,
> no shadows, no 3D effects, no tiny details. Orange #ff891f symbol with warm ivory check/negative
> space. Center the mark with generous consistent padding so it fits the safe central two-thirds
> of an Android adaptive icon. Transparent background, no tile, no mockups, no border, no other
> objects. Must read clearly at 24 to 48 pixels. Square composition, professional restrained design.

Export transparent sizes with ImageMagick, preserving alpha. For square tiles, resize the full
source canvas, then flatten onto the charcoal background. Do not trim the transparent margins:
they provide the maskable icon safe area. The Android foreground uses a 316px source
resize centered on a 432px transparent canvas, keeping visible artwork inside the 66dp
safe circle of the 108dp adaptive layer.
