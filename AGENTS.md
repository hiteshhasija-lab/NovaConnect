# NovaConnect implementation guidance

## UI density standard (user-approved)
Use the compact three-dot chat menu as the height and spacing reference for all future enhancements. Reuse the shared CSS variables in `public/css/ui-density.css`: 36px minimum control height, 4.62px vertical padding, 15.4px horizontal padding, 12.32px item gap, and 15.4px section spacing. These are rendered CSS pixels derived from the approved menu at 0.77 scale. Do not apply zoom again to new controls. In existing zoomed containers, compensate for that scale once as the menu rules do.
Preserve approved font sizes unless the user asks to change them. Multi-line rows and text areas may grow to fit content; never clip names, descriptions, focus rings or translated labels to force a fixed height. Use the standard for new menus, toolbars, forms and member/user lists; check keyboard focus, narrow screens and long labels. User instructions override this default.
