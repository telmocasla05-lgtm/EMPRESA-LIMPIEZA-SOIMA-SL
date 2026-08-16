// Tipos de incidencia y sus etiquetas, en un módulo sin dependencias.
//
// Vive aparte de lib/ia/clasificar-incidencia.ts para que el panel pueda usar
// las etiquetas sin arrastrar el SDK de Anthropic al bundle del navegador.

export type TipoIncidencia =
  | "material_roto"
  | "falta_stock"
  | "desperfecto"
  | "seguridad"
  | "sin_clasificar";

export type UrgenciaIncidencia = "alta" | "normal";

// Textos de interfaz y de WhatsApp, en español (CLAUDE.md).
export const ETIQUETAS_TIPO: Record<TipoIncidencia, string> = {
  material_roto: "Material roto",
  falta_stock: "Falta de stock",
  desperfecto: "Desperfecto en el centro",
  seguridad: "Seguridad",
  sin_clasificar: "Sin clasificar",
};

export const TIPOS = Object.keys(ETIQUETAS_TIPO) as TipoIncidencia[];

// Los cuatro tipos de negocio: los únicos que pueden tener responsable.
// 'sin_clasificar' es un estado técnico y avisa siempre a la empresa.
export const TIPOS_CON_RESPONSABLE = TIPOS.filter(
  (tipo): tipo is Exclude<TipoIncidencia, "sin_clasificar"> =>
    tipo !== "sin_clasificar",
);

// Pistas para el panel: qué entra en cada tipo, con el mismo criterio que el
// prompt de clasificación.
export const EJEMPLOS_TIPO: Record<
  Exclude<TipoIncidencia, "sin_clasificar">,
  string
> = {
  material_roto: "Fregonas, carros, aspiradoras… material de la empresa",
  falta_stock: "Papel, jabón, bolsas, producto agotado",
  desperfecto: "Cristales, grifos, persianas… del edificio del cliente",
  seguridad: "Riesgo para las personas. Siempre urgente",
};
