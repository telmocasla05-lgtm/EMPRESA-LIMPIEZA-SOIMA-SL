import { describe, expect, it } from "vitest";
import { isShortMapsLink, parseCoordinates } from "@/lib/maps";

describe("parseCoordinates", () => {
  it("extrae de una URL de lugar (prioriza !3d!4d sobre @)", () => {
    const url =
      "https://www.google.com/maps/place/Puerta+del+Sol/@40.4159,-3.7086,15z/data=!3m1!4b1!4m6!3m5!1s0xd42287e1c9bfffb:0x821f0e1ff4de3f13!8m2!3d40.4167754!4d-3.7037902!16zL20vMDNoNG0z";
    expect(parseCoordinates(url)).toEqual({
      latitude: 40.4167754,
      longitude: -3.7037902,
    });
  });

  it("extrae del formato @lat,lng", () => {
    expect(
      parseCoordinates("https://www.google.com/maps/@40.4168,-3.7038,17z"),
    ).toEqual({ latitude: 40.4168, longitude: -3.7038 });
  });

  it("extrae del parámetro q=", () => {
    expect(
      parseCoordinates("https://maps.google.com/?q=40.4168,-3.7038"),
    ).toEqual({ latitude: 40.4168, longitude: -3.7038 });
  });

  it("extrae del parámetro query= con coma codificada", () => {
    expect(
      parseCoordinates(
        "https://www.google.com/maps/search/?api=1&query=40.4168%2C-3.7038",
      ),
    ).toEqual({ latitude: 40.4168, longitude: -3.7038 });
  });

  it("acepta coordenadas pegadas directamente", () => {
    expect(parseCoordinates("40.4168, -3.7038")).toEqual({
      latitude: 40.4168,
      longitude: -3.7038,
    });
  });

  it("rechaza texto sin coordenadas y valores fuera de rango", () => {
    expect(parseCoordinates("https://www.google.com/maps")).toBeNull();
    expect(parseCoordinates("hola")).toBeNull();
    expect(parseCoordinates("95.0, -3.7")).toBeNull();
    expect(parseCoordinates("")).toBeNull();
  });
});

describe("isShortMapsLink", () => {
  it("detecta enlaces cortos", () => {
    expect(isShortMapsLink("https://maps.app.goo.gl/AbCdEf123")).toBe(true);
    expect(isShortMapsLink("https://goo.gl/maps/AbCdEf123")).toBe(true);
    expect(isShortMapsLink("https://www.google.com/maps/@40.4,-3.7,15z")).toBe(
      false,
    );
  });
});
