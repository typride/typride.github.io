# Trip photos for the world map

Drop photos here and the matching map pin starts **pulsing** and opens a
**lightbox carousel** when clicked.

## How to add photos to a pin

1. Make a folder named for the place's **slug** (see the list below):
   `images/trips/kyoto-japan/`
2. Put your photos in it — any `.jpg / .jpeg / .png / .webp / .gif / .avif`.
   They show **in filename order**, so name them `01.jpg`, `02.jpg`, … to control
   the sequence.
3. Regenerate the manifest:
   ```
   node scripts/build-trips.js
   ```
4. Commit + push. Done — that pin is now a photo pin.

> Keep images web-sized (long edge ~1600–2000px, < ~500 KB each) so the map
> stays fast. `manifest.json` is auto-generated — don't edit it by hand.

## Slugs (folder name → pin)

```
seattle-wa                     Seattle, WA
portland-or                    Portland, OR
los-angeles-ca                 Los Angeles, CA
boulder-co                     Boulder, CO
oklahoma-city-ok               Oklahoma City, OK
nashville-tn                   Nashville, TN
tampa-fl                       Tampa, FL
virginia-beach-va              Virginia Beach, VA
new-york-ny                    New York, NY
oahu-hawaii                    Oahu, Hawaii
juneau-alaska                  Juneau, Alaska
valdez-alaska                  Valdez, Alaska
naknek-alaska                  Naknek, Alaska
toolik-field-station-alaska    Toolik Field Station, Alaska
mexico-city                    Mexico City
puerto-escondido-mexico        Puerto Escondido, Mexico
sayulita-mexico                Sayulita, Mexico
porto-portugal                 Porto, Portugal
lisbon-portugal                Lisbon, Portugal
the-algarve-portugal           The Algarve, Portugal
barcelona-spain                Barcelona, Spain
valencia-spain                 Valencia, Spain
paris-france                   Paris, France
marseille-france               Marseille, France
monte-carlo-monaco             Monte Carlo, Monaco
rome-italy                     Rome, Italy
pisa-italy                     Pisa, Italy
siena-italy                    Siena, Italy
tuscany-italy                  Tuscany, Italy
swiss-alps                     Swiss Alps
salzburg-austria               Salzburg, Austria
vienna-austria                 Vienna, Austria
munich-germany                 Munich, Germany
nuremberg-germany              Nuremberg, Germany
prague-czechia                 Prague, Czechia
krakow-poland                  Krakow, Poland
budapest-hungary               Budapest, Hungary
london-uk                      London, UK
athens-greece                  Athens, Greece
milos-greece                   Milos, Greece
tokyo-japan                    Tokyo, Japan
nagano-japan                   Nagano, Japan
kyoto-japan                    Kyoto, Japan
nasu-japan                     Nasu, Japan
hampi-india                    Hampi, India
bangalore-india                Bangalore, India
```

Add a new pin in `scripts/home.js` (the `PLACES` array) and it gets a slug the
same way.
