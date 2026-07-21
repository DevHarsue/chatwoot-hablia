# Guía de revisión — Hablia CRM Chatwoot

Esta guía es la fuente de verdad para el pre-review local y para revisiones de
pull requests. Se aplica al diff contra la rama base, a las instrucciones de
`AGENTS.md` y a las restricciones de seguridad del repositorio.

## Alcance de la revisión

- Revisá cada línea añadida o modificada y el comportamiento que pueda afectar.
- Para cambios de runtime, verificá la ruta equivalente en `enterprise/` antes
  de aprobar el cambio.
- Para instrucciones, hooks, MCP y automatización, verificá la paridad Claude
  y Codex, el control de drift y que no se versionen credenciales.
- No atribuyas al diff fallos demostrablemente presentes en la base; reportalos
  por separado como deuda heredada con el archivo y comando que lo evidencia.

## Severidades

### BLOCKING

Un hallazgo bloquea el push o PR cuando introduce un secreto, una escritura
externa no autorizada, una regresión funcional, una incompatibilidad Enterprise,
un bypass de seguridad o validación, una divergencia sin excepción aprobada entre
Claude y Codex, o un error del analizador en archivos cambiados.

### WARNING

Un warning no demuestra una regresión inmediata, pero requiere decisión explícita
antes del push: cobertura insuficiente del comportamiento cambiado, documentación
que no permite operar el cambio, validación relevante omitida, o un riesgo de
compatibilidad no resuelto.

### SUGGESTION

Una sugerencia mejora claridad, mantenibilidad o consistencia sin afectar la
seguridad, el contrato público ni la entrega actual.

## NEVER

- Nunca aprobar secretos, tokens, cookies, claves, datos de clientes o rutas
  locales versionadas.
- Nunca aprobar deploys, envíos de mensajes, migraciones destructivas ni otras
  escrituras externas sin confirmación explícita y objetivo verificado.
- Nunca permitir que una configuración exclusiva de Claude o Codex redefina el
  núcleo compartido o quede sin adaptador equivalente o excepción AIC vigente.
- Nunca restaurar `CLAUDE.md` como symlink ni permitir imports rotos.
- Nunca permitir un `git push` o `gh pr create` de una rama de trabajo sin el
  marcador `.agents/.pre-review-passed` que coincida con el diff actual.
- Nunca modificar código de producto, dependencias o lockfiles en una tarea de
  documentación o tooling salvo que la issue lo requiera explícitamente.

## Validación y límites

- Ejecutá los checks definidos en `AGENTS.md` que correspondan a los archivos
  cambiados. Los errores nuevos son BLOCKING.
- Los fallos heredados deben compararse contra la base antes de reportarlos;
  no se corrigen de forma oportunista dentro de una migración de tooling.
- Un cambio transversal necesita justificación en la issue y evidencia
  determinista. Para esta superficie, el checker, sus fixtures y las pruebas del
  gate son el mínimo obligatorio.
- Rechazá cambios que amplíen permisos, introduzcan secretos, o dependan de
  rutas específicas de una sola plataforma sin validación o excepción aprobada.

## Formato de salida

Todas las revisiones deben usar exactamente estas secciones, incluso cuando el
conteo sea cero:

```markdown
## BLOCKING (n)

- [category] `path:line` — impacto y corrección requerida.

## WARNINGS (n)

- [category] `path:line` — riesgo, evidencia y decisión requerida.

## SUGGESTIONS (n)

- [category] `path:line` — mejora no bloqueante.

## Verdict

PASS | WARN | FAIL
```

Usá `Ninguno.` cuando una sección no tenga hallazgos. Un BLOCKING debe incluir
el comportamiento actual y el requerido. `FAIL` corresponde a uno o más
BLOCKING; `WARN`, a cero BLOCKING y uno o más WARNINGS; `PASS`, a cero
BLOCKING y cero WARNINGS.
