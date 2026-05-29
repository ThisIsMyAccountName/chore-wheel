# 🎡 Chore Wheel Card

Turn your Home Assistant `todo` list into a spinning carnival wheel. Hit
**Spin**, let the wheel pick a chore, then **Mark done** to strike it off.

- Reads chores live from any `todo.*` entity
- Smooth carnival spin animation
- "Mark done" completes or removes the chosen item
- Customisable colours, title and spin duration
- Visual editor, no YAML required

```yaml
type: custom:chore-wheel-card
entity: todo.chores
```

See the [README](https://github.com/ThisIsMyAccountName/chore-wheel) for full setup.
