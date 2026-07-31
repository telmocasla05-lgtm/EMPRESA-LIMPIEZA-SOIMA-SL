export type Coordinates = { latitude: number; longitude: number };

// Extrae coordenadas de un enlace de Google Maps o de un texto "lat, lng".
// Prioridad: !3d..!4d.. (coordenadas exactas del sitio) sobre @lat,lng
// (que es el centro del visor, no el marcador).
export function parseCoordinates(input: string): Coordinates | null {
  const text = input.trim();
  if (!text) return null;

  const plain = text.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (plain) return validate(Number(plain[1]), Number(plain[2]));

  const bang = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (bang) return validate(Number(bang[1]), Number(bang[2]));

  const at = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) return validate(Number(at[1]), Number(at[2]));

  const query = text.match(
    /[?&](?:q|ll|query|destination)=(-?\d+(?:\.\d+)?)(?:%2C|,)\s*(-?\d+(?:\.\d+)?)/i,
  );
  if (query) return validate(Number(query[1]), Number(query[2]));

  return null;
}

// Los enlaces cortos no llevan las coordenadas en la URL: hay que abrirlos
// en el navegador y copiar la URL completa.
export function isShortMapsLink(input: string): boolean {
  return /(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(input);
}

function validate(latitude: number, longitude: number): Coordinates | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}
