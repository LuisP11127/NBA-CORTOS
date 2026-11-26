# NBA-CORTOS

DICA NBA: proyecciones y picks de la NBA. Son páginas estáticas, sin login ni servidor.

- `index.html`: la app (equipos, Vegas 2.0, jugadores, picks, 1er cuarto, resultados). Todos tienen las funciones de administrador.
- `importador.html`: carga equipos, rosters, estadísticas, partidos y líneas desde ESPN o desde archivos CSV/Excel.
- `localdb.js`: base de datos local (IndexedDB) que usan las dos páginas.

## Dónde se guardan los datos

Todo se guarda en el navegador de cada dispositivo. La app y el importador comparten los datos si se abren desde el mismo sitio (por ejemplo, el mismo dominio de GitHub Pages). Un dispositivo nuevo empieza vacío: hay que cargar los datos con el importador o usar **Copia de seguridad** en el importador para pasarlos de un dispositivo a otro.
