# Third-party sources

CtrlHoverDict is a GPL-3.0-only fork of Pot, based on upstream commit
`594d32ede96acd106b0256deaa8bb440ffcdff40`. The original `LICENSE` and upstream
attribution remain in the repository.

- Pot: https://github.com/pot-app/pot-desktop
- Tauri and its plugins: MIT / Apache-2.0. The single-instance v1 compatibility
  patch is in `src-tauri/vendor/tauri-plugin-single-instance/`; original full
  license texts and a patch note are included there.
- Tesseract.js / Tesseract OCR and language data: Apache-2.0. Packaged English
  and Simplified Chinese files come from
  `https://tessdata.projectnaptha.com/4.0.0/` (the Tesseract.js language data host).
  The tessdata license is included at `public/tessdata/LICENSE`.
- Interaction/layout reference only: https://github.com/jackguo2001/hover-translate
  (MIT). No OCR or translation backend was copied from that repository.
- SM2 description: https://super-memory.com/english/ol/sm2.htm .

Packaged language resource SHA256:

| File | SHA256 |
| --- | --- |
| eng.traineddata.gz | ED350F3752F81EE8F38769EDC14D92D997DABABE23B565C59879372CC46A2468 |
| chi_sim.traineddata.gz | 59388039851E4D1293D729C183FD8C1FA9BBBB959EED996E945024671E68C1D6 |

Other dependencies retain their respective notices in their upstream packages.
