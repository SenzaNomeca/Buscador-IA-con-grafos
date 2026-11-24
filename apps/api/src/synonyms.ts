/**
 * Expansión semántica mínima para la búsqueda léxica.
 *
 * Los metadatos del catálogo mezclan formas flexionadas y sinónimos cercanos
 * ("sonriendo" vs "sonrisa" / "sonriente", "oficina" vs "escritorio"). El
 * matching por token exacto no los une y pierde resultados que el usuario sí
 * espera. Este mapa es deliberadamente pequeño y curado: agrupa solo términos
 * con una equivalencia visual clara. No traduce conceptos completos ni usa
 * hyponimos ("persona" ≠ "mujer") porque eso reabriría el ruido.
 *
 * Todos los términos están normalizados (minúsculas, sin tildes), igual que el
 * índice del grafo y `meaningfulTerms`.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  // Emociones / expresiones.
  ['sonreir', 'sonriendo', 'sonriente', 'sonrientes', 'sonrisa', 'sonrisas', 'sonrie', 'sonrien', 'smile', 'smiling', 'smiles'],
  ['feliz', 'felices', 'felicidad', 'alegre', 'alegres', 'contento', 'contenta', 'contentos', 'contentas', 'happy', 'joyful'],
  ['triste', 'tristes', 'tristeza', 'melancolico', 'melancolica', 'sad'],
  ['enojado', 'enojada', 'enojo', 'furioso', 'furiosa', 'molesto', 'molesta', 'angry'],

  // Personas / profesiones.
  ['mujer', 'mujeres', 'femenino', 'femenina', 'female', 'woman', 'women'],
  ['hombre', 'hombres', 'masculino', 'masculina', 'male', 'man', 'men'],
  ['persona', 'personas', 'individuo', 'individuos'],
  ['abogado', 'abogada', 'abogados', 'abogadas', 'letrado', 'letrada', 'jurista', 'legal', 'juridico', 'juridica', 'lawyer', 'attorney'],
  ['medico', 'medica', 'medicos', 'doctor', 'doctora', 'doctores', 'salud', 'health'],
  ['profesor', 'profesora', 'profesores', 'docente', 'docentes', 'maestro', 'maestra', 'teacher'],
  ['estudiante', 'estudiantes', 'alumno', 'alumna', 'alumnos', 'alumnas', 'student'],

  // Espacios / objetos.
  ['oficina', 'oficinas', 'escritorio', 'escritorios', 'despacho', 'despachos', 'office', 'workspace', 'workplace'],
  ['fondo', 'fondos', 'background', 'backdrop'],
  ['mesa', 'mesas', 'table'],
  ['silla', 'sillas', 'chair'],
  ['ventana', 'ventanas', 'window'],
  ['cafe', 'cafes', 'coffee', 'cafeteria'],
  ['comida', 'comidas', 'alimento', 'alimentos', 'food', 'meal'],
  ['reunion', 'reuniones', 'meeting', 'junta', 'juntas'],
  ['negocio', 'negocios', 'empresa', 'empresas', 'corporativo', 'corporativa', 'business', 'corporate'],

  // Estilo / color / luz.
  ['minimalista', 'minimalistas', 'minimal', 'minimalism', 'minimalist'],
  ['moderno', 'moderna', 'modernos', 'modernas', 'modern', 'contemporaneo', 'contemporanea', 'contemporary'],
  ['blanco', 'blanca', 'blancos', 'blancas', 'white'],
  ['negro', 'negra', 'negros', 'negras', 'black'],
  ['rojo', 'roja', 'rojos', 'rojas', 'red'],
  ['azul', 'azules', 'blue'],
  ['verde', 'verdes', 'green'],
  ['amarillo', 'amarilla', 'amarillos', 'amarillas', 'yellow'],
  ['gris', 'grises', 'gray', 'grey'],
  ['beige', 'beiges'],
  ['marron', 'marrones', 'brown'],
  ['naranja', 'naranjas', 'orange'],
  ['rosa', 'rosado', 'rosada', 'pink'],
  ['morado', 'morada', 'morados', 'moradas', 'purple'],
  ['violeta', 'violetas', 'violet'],
  ['dorado', 'dorada', 'dorados', 'doradas', 'gold', 'golden'],
  ['plateado', 'plateada', 'plateados', 'plateadas', 'silver'],
  ['turquesa', 'turquesas', 'turquoise'],
  ['luz', 'luces', 'iluminacion', 'light', 'lighting'],

  // Naturaleza / animales.
  ['gato', 'gata', 'gatos', 'gatas', 'felino', 'felina'],
  ['perro', 'perra', 'perros', 'perras', 'cachorro', 'cachorra'],
  ['pajaro', 'pajaros', 'bird', 'birds'],
  ['caballo', 'caballos', 'horse'],
  ['flor', 'flores', 'flower', 'flowers'],
  ['arbol', 'arboles', 'tree', 'trees'],
  ['montana', 'montanas', 'mountain', 'mountains'],
  ['mar', 'oceano', 'ocean', 'sea'],
  ['cielo', 'cielos', 'sky'],
  ['playa', 'playas', 'costa', 'costas', 'beach', 'coast'],
  ['naturaleza', 'natural', 'paisaje', 'paisajes', 'landscape', 'nature'],
  ['agua', 'aguas', 'water'],
  ['fuego', 'fuegos', 'fire'],

  // Ciudad / transporte / tecnología.
  ['ciudad', 'ciudades', 'urbano', 'urbana', 'urbanos', 'urbanas', 'city', 'urban'],
  // Sin "carro": en el catálogo aparece mucho como carro de compras/herramientas.
  ['coche', 'coches', 'auto', 'autos', 'automovil', 'automoviles', 'car'],
  ['tecnologia', 'tecnologias', 'tecnologico', 'tecnologica', 'digital', 'tech'],
  ['robot', 'robots', 'robotico', 'robotica', 'robotic'],
  ['noche', 'noches', 'nocturno', 'nocturna', 'night'],
  ['dia', 'dias', 'diurno', 'diurna', 'day', 'daylight'],
];

/**
 * Términos de color normalizados. La cohesión los trata aparte: un color debe
 * compartir tag con el sustantivo al que califica ("fondo blanco" no es
 * "fondo" + "rectángulos blancos"). Si el color va solo, no se aplica.
 */
export const COLOR_TERMS: ReadonlySet<string> = new Set([
  'blanco',
  'blanca',
  'blancos',
  'blancas',
  'white',
  'negro',
  'negra',
  'negros',
  'negras',
  'black',
  'rojo',
  'roja',
  'rojos',
  'rojas',
  'red',
  'azul',
  'azules',
  'blue',
  'verde',
  'verdes',
  'green',
  'amarillo',
  'amarilla',
  'amarillos',
  'amarillas',
  'yellow',
  'gris',
  'grises',
  'gray',
  'grey',
  'beige',
  'beiges',
  'marron',
  'marrones',
  'brown',
  'naranja',
  'naranjas',
  'orange',
  'rosa',
  'rosado',
  'rosada',
  'pink',
  'morado',
  'morada',
  'morados',
  'moradas',
  'purple',
  'violeta',
  'violetas',
  'violet',
  'dorado',
  'dorada',
  'dorados',
  'doradas',
  'gold',
  'golden',
  'plateado',
  'plateada',
  'plateados',
  'plateadas',
  'silver',
  'turquesa',
  'turquesas',
  'turquoise',
]);

const SYNONYMS = new Map<string, string[]>();

for (const group of SYNONYM_GROUPS) {
  for (const term of group) {
    const variants = SYNONYMS.get(term) ?? [];
    for (const other of group) {
      if (other !== term && !variants.includes(other)) variants.push(other);
    }
    SYNONYMS.set(term, variants);
  }
}

const cache = new Map<string, string[]>();

/** Devuelve el término original + sus sinónimos normalizados. */
export function expandTerm(term: string): string[] {
  const cached = cache.get(term);
  if (cached) return cached;

  const result = [term, ...(SYNONYMS.get(term) ?? [])];
  if (cache.size > 5000) cache.clear();
  cache.set(term, result);
  return result;
}
