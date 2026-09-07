// A bike catalogue, kept for exactly one reason: the feasibility engine grades
// every day against `trip.meta.range` — comfort miles, absolute miles, mpg —
// and asking a rider to know those three numbers is asking the wrong question.
// They know what they ride. Tank capacity times real-world economy answers it.
//
// Scope is deliberate and admitted:
//
//   * These are FAMILY specs, not trim-level ones. Tank capacity is stable
//     across a model's run and is what the arithmetic needs; where a trim
//     genuinely differs (a Low with a smaller tank, a Tour Pack model) it gets
//     its own row rather than a fudged average.
//   * `mpg` is a LOADED, real-world figure — two-up with luggage at highway
//     speed — not the manufacturer's. A range that grades a fuel gap has to be
//     pessimistic or it is worse than no range at all.
//   * `years` says when the spec holds. A rider on an older bike than the range
//     given should check their own tank.
//
// The catalogue is a convenience, never an authority: everything it fills in is
// editable, and a rider's own observed mpg beats any published figure. Anything
// not in here is entered by hand — that path is first-class, not a fallback.
//
// US gallons throughout; the UI converts.

export const BIKES = [
  // ---- Harley-Davidson --------------------------------------------------
  { make: 'Harley-Davidson', model: 'Road Glide', years: '2015+', tank: 6.0, mpg: 38, weight: 855 },
  { make: 'Harley-Davidson', model: 'Street Glide', years: '2014+', tank: 6.0, mpg: 38, weight: 830 },
  { make: 'Harley-Davidson', model: 'Road King', years: '2014+', tank: 6.0, mpg: 39, weight: 820 },
  { make: 'Harley-Davidson', model: 'Electra Glide Ultra Limited', years: '2014+', tank: 6.0, mpg: 36, weight: 905 },
  { make: 'Harley-Davidson', model: 'Heritage Classic', years: '2018+', tank: 5.0, mpg: 40, weight: 728 },
  { make: 'Harley-Davidson', model: 'Fat Boy', years: '2018+', tank: 5.0, mpg: 40, weight: 699 },
  { make: 'Harley-Davidson', model: 'Low Rider S', years: '2020+', tank: 5.0, mpg: 40, weight: 679 },
  { make: 'Harley-Davidson', model: 'Softail Standard', years: '2020+', tank: 3.5, mpg: 43, weight: 655 },
  { make: 'Harley-Davidson', model: 'Sport Glide', years: '2018+', tank: 5.0, mpg: 42, weight: 683 },
  { make: 'Harley-Davidson', model: 'Breakout', years: '2018+', tank: 3.5, mpg: 40, weight: 683 },
  { make: 'Harley-Davidson', model: 'Sportster S', years: '2021+', tank: 3.1, mpg: 43, weight: 502 },
  { make: 'Harley-Davidson', model: 'Nightster', years: '2022+', tank: 3.1, mpg: 47, weight: 481 },
  { make: 'Harley-Davidson', model: 'Iron 883', years: '2014-2022', tank: 3.3, mpg: 48, weight: 564 },
  { make: 'Harley-Davidson', model: 'Pan America 1250', years: '2021+', tank: 5.6, mpg: 44, weight: 559 },
  { make: 'Harley-Davidson', model: 'Road Glide Ultra', years: '2016+', tank: 6.0, mpg: 36, weight: 906 },
  { make: 'Harley-Davidson', model: 'Freewheeler', years: '2015+', tank: 6.0, mpg: 34, weight: 1105 },
  { make: 'Harley-Davidson', model: 'Tri Glide Ultra', years: '2014+', tank: 6.0, mpg: 32, weight: 1200 },

  // ---- Indian -----------------------------------------------------------
  { make: 'Indian', model: 'Chieftain', years: '2014+', tank: 5.5, mpg: 38, weight: 848 },
  { make: 'Indian', model: 'Roadmaster', years: '2015+', tank: 5.5, mpg: 36, weight: 949 },
  { make: 'Indian', model: 'Challenger', years: '2020+', tank: 6.0, mpg: 38, weight: 831 },
  { make: 'Indian', model: 'Pursuit', years: '2022+', tank: 6.0, mpg: 36, weight: 929 },
  { make: 'Indian', model: 'Springfield', years: '2016+', tank: 5.5, mpg: 39, weight: 819 },
  { make: 'Indian', model: 'Scout', years: '2015+', tank: 3.3, mpg: 45, weight: 558 },
  { make: 'Indian', model: 'Scout Bobber', years: '2018+', tank: 3.3, mpg: 45, weight: 549 },
  { make: 'Indian', model: 'Super Chief', years: '2021+', tank: 4.0, mpg: 41, weight: 730 },
  { make: 'Indian', model: 'FTR 1200', years: '2019+', tank: 3.4, mpg: 40, weight: 518 },

  // ---- Honda ------------------------------------------------------------
  { make: 'Honda', model: 'Gold Wing Tour', years: '2018+', tank: 5.5, mpg: 40, weight: 833 },
  { make: 'Honda', model: 'Gold Wing GL1800', years: '2001-2017', tank: 6.6, mpg: 37, weight: 904 },
  { make: 'Honda', model: 'Africa Twin CRF1100L', years: '2020+', tank: 5.0, mpg: 46, weight: 501 },
  { make: 'Honda', model: 'Africa Twin Adventure Sports', years: '2020+', tank: 6.5, mpg: 45, weight: 535 },
  { make: 'Honda', model: 'NC750X', years: '2016+', tank: 3.7, mpg: 62, weight: 481 },
  { make: 'Honda', model: 'Rebel 1100', years: '2021+', tank: 3.6, mpg: 48, weight: 487 },
  { make: 'Honda', model: 'Rebel 500', years: '2017+', tank: 3.0, mpg: 60, weight: 408 },
  { make: 'Honda', model: 'CB500X', years: '2019+', tank: 4.6, mpg: 62, weight: 439 },
  { make: 'Honda', model: 'CB1000R', years: '2018+', tank: 4.3, mpg: 40, weight: 467 },

  // ---- BMW --------------------------------------------------------------
  { make: 'BMW', model: 'R 1250 GS', years: '2019+', tank: 5.3, mpg: 46, weight: 549 },
  { make: 'BMW', model: 'R 1250 GS Adventure', years: '2019+', tank: 7.9, mpg: 45, weight: 591 },
  { make: 'BMW', model: 'R 1300 GS', years: '2024+', tank: 5.0, mpg: 48, weight: 523 },
  { make: 'BMW', model: 'R 1250 RT', years: '2019+', tank: 6.6, mpg: 45, weight: 615 },
  { make: 'BMW', model: 'K 1600 GTL', years: '2017+', tank: 7.0, mpg: 38, weight: 782 },
  { make: 'BMW', model: 'K 1600 GT', years: '2017+', tank: 7.0, mpg: 39, weight: 750 },
  { make: 'BMW', model: 'F 900 XR', years: '2020+', tank: 4.1, mpg: 48, weight: 483 },
  { make: 'BMW', model: 'F 850 GS', years: '2018+', tank: 4.0, mpg: 50, weight: 504 },
  { make: 'BMW', model: 'R nineT', years: '2014+', tank: 4.8, mpg: 42, weight: 489 },
  { make: 'BMW', model: 'S 1000 XR', years: '2020+', tank: 5.3, mpg: 40, weight: 494 },

  // ---- Yamaha -----------------------------------------------------------
  { make: 'Yamaha', model: 'Tenere 700', years: '2021+', tank: 4.2, mpg: 52, weight: 452 },
  { make: 'Yamaha', model: 'Super Tenere ES', years: '2014+', tank: 6.1, mpg: 42, weight: 584 },
  { make: 'Yamaha', model: 'Tracer 9 GT', years: '2021+', tank: 5.0, mpg: 45, weight: 485 },
  { make: 'Yamaha', model: 'MT-09', years: '2021+', tank: 3.7, mpg: 44, weight: 417 },
  { make: 'Yamaha', model: 'MT-07', years: '2018+', tank: 3.7, mpg: 55, weight: 406 },
  { make: 'Yamaha', model: 'Star Venture', years: '2018+', tank: 6.6, mpg: 34, weight: 963 },
  { make: 'Yamaha', model: 'Bolt', years: '2014+', tank: 3.2, mpg: 47, weight: 542 },

  // ---- Kawasaki ---------------------------------------------------------
  { make: 'Kawasaki', model: 'Versys 1000', years: '2019+', tank: 5.5, mpg: 43, weight: 566 },
  { make: 'Kawasaki', model: 'Versys 650', years: '2015+', tank: 5.5, mpg: 52, weight: 476 },
  { make: 'Kawasaki', model: 'Vulcan 1700 Voyager', years: '2014+', tank: 5.3, mpg: 36, weight: 895 },
  { make: 'Kawasaki', model: 'Vulcan S', years: '2015+', tank: 3.7, mpg: 50, weight: 498 },
  { make: 'Kawasaki', model: 'Ninja 1000SX', years: '2020+', tank: 5.0, mpg: 42, weight: 518 },
  { make: 'Kawasaki', model: 'KLR650', years: '2022+', tank: 6.1, mpg: 48, weight: 456 },
  { make: 'Kawasaki', model: 'Z900', years: '2020+', tank: 4.5, mpg: 42, weight: 467 },

  // ---- Suzuki -----------------------------------------------------------
  { make: 'Suzuki', model: 'V-Strom 1050', years: '2020+', tank: 5.3, mpg: 44, weight: 545 },
  { make: 'Suzuki', model: 'V-Strom 650', years: '2017+', tank: 5.3, mpg: 55, weight: 470 },
  { make: 'Suzuki', model: 'Hayabusa', years: '2022+', tank: 5.3, mpg: 38, weight: 582 },
  { make: 'Suzuki', model: 'Boulevard M109R', years: '2014+', tank: 5.2, mpg: 36, weight: 764 },
  { make: 'Suzuki', model: 'SV650', years: '2017+', tank: 3.8, mpg: 53, weight: 437 },

  // ---- Triumph ----------------------------------------------------------
  { make: 'Triumph', model: 'Tiger 1200 GT Explorer', years: '2022+', tank: 7.9, mpg: 44, weight: 564 },
  { make: 'Triumph', model: 'Tiger 900 GT', years: '2020+', tank: 5.3, mpg: 50, weight: 476 },
  { make: 'Triumph', model: 'Rocket 3 GT', years: '2020+', tank: 4.8, mpg: 34, weight: 642 },
  { make: 'Triumph', model: 'Bonneville T120', years: '2016+', tank: 3.8, mpg: 50, weight: 526 },
  { make: 'Triumph', model: 'Speed Triple 1200 RS', years: '2021+', tank: 4.1, mpg: 38, weight: 439 },
  { make: 'Triumph', model: 'Scrambler 1200', years: '2019+', tank: 4.2, mpg: 45, weight: 452 },

  // ---- KTM / Ducati / others -------------------------------------------
  { make: 'KTM', model: '1290 Super Adventure S', years: '2021+', tank: 6.1, mpg: 42, weight: 542 },
  { make: 'KTM', model: '890 Adventure R', years: '2021+', tank: 5.3, mpg: 48, weight: 456 },
  { make: 'KTM', model: '790 Duke', years: '2018+', tank: 3.7, mpg: 46, weight: 373 },
  { make: 'Ducati', model: 'Multistrada V4', years: '2021+', tank: 5.8, mpg: 40, weight: 529 },
  { make: 'Ducati', model: 'Multistrada 950', years: '2019+', tank: 5.3, mpg: 44, weight: 500 },
  { make: 'Ducati', model: 'Monster', years: '2021+', tank: 3.7, mpg: 44, weight: 414 },
  { make: 'Moto Guzzi', model: 'V85 TT', years: '2019+', tank: 6.1, mpg: 50, weight: 505 },
  { make: 'Moto Guzzi', model: 'V7', years: '2021+', tank: 5.5, mpg: 50, weight: 476 },
  { make: 'Royal Enfield', model: 'Himalayan 450', years: '2024+', tank: 4.5, mpg: 65, weight: 434 },
  { make: 'Royal Enfield', model: 'Super Meteor 650', years: '2023+', tank: 4.1, mpg: 55, weight: 531 },
  { make: 'Royal Enfield', model: 'Interceptor 650', years: '2019+', tank: 3.4, mpg: 57, weight: 445 },
  { make: 'Aprilia', model: 'Tuareg 660', years: '2022+', tank: 4.8, mpg: 50, weight: 449 },
  { make: 'Zero', model: 'DSR/X', years: '2023+', tank: 0, mpg: 0, weight: 544, electric: true, rangeMi: 150 },
  { make: 'Zero', model: 'SR/S', years: '2022+', tank: 0, mpg: 0, weight: 516, electric: true, rangeMi: 140 },
  { make: 'LiveWire', model: 'S2 Del Mar', years: '2023+', tank: 0, mpg: 0, weight: 436, electric: true, rangeMi: 110 },
];

export const bikeLabel = (b) => `${b.make} ${b.model}`;

// Tokenised contains-match, so "road glide", "glide road" and "rd glide" all
// find the same bike, and "gs 1250" finds the R 1250 GS. Riders do not type
// catalogue names.
export function searchBikes(query, limit = 8) {
  const q = String(query ?? '').toLowerCase().trim();
  if (q.length < 2) return [];
  const terms = q.split(/[\s-]+/).filter(Boolean);
  const scored = [];
  for (const b of BIKES) {
    const hay = `${b.make} ${b.model} ${b.years}`.toLowerCase();
    if (!terms.every((term) => hay.includes(term))) continue;
    // Prefer the shortest name that matched — "Scout" should beat "Scout
    // Bobber" for the query "scout".
    scored.push({ bike: b, score: hay.indexOf(terms[0]) * 100 + bikeLabel(b).length });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.bike);
}

// Tank × economy is the absolute range; comfort keeps a reserve, because a
// rider who plans to arrive on fumes has no plan. An electric bike states its
// range outright — there is no tank to multiply.
export const RESERVE = 0.8;

export function rangeFromBike(bike) {
  if (!bike) return null;
  const tank = Number(bike.tank);
  const mpg = Number(bike.mpg);
  if (bike.electric && Number(bike.rangeMi) > 0) {
    const absolute = Math.round(Number(bike.rangeMi));
    return { comfort: Math.round(absolute * RESERVE), absolute, mpg: 0 };
  }
  if (!(tank > 0) || !(mpg > 0)) return null;
  const absolute = Math.round(tank * mpg);
  return { comfort: Math.round(absolute * RESERVE), absolute, mpg: Math.round(mpg) };
}
