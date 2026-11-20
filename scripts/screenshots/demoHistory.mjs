/**
 * What happened in the demo's repositories (demo.mjs builds them): a made-up
 * team's three months on "pantry", a meal-planning app. Data only — each
 * repository's steps in order, then the changes left uncommitted.
 *
 * The story gives every screenshot something to show:
 * - web's log has parallel branches, merges, tags and a release branch; its
 *   `main` is two commits behind origin and `feature/meal-planner` (checked
 *   out) four ahead, two of them small fixes the rebase scene folds into the
 *   commits they fix; `feature/recipe-import` is only on origin.
 * - api is one commit ahead of origin; shared is in step with it.
 * - `web/src/cart/totals.ts` was written by three people (blame) and has an
 *   uncommitted change (the diff); shared's `feature/currency-display` and
 *   `main` both changed `src/money.ts`, so merging them conflicts.
 * - web and api have uncommitted changes, for the Commit window; one of them,
 *   in `WeekView.tsx`, is a forgotten `console.log` the Commit scene leaves out.
 *
 * Lines are kept short (72 characters; 48 in `money.ts`, which the merge
 * scene shows three times side by side) so the side-by-side views show them
 * whole.
 *
 * File text below is real TypeScript, SQL, CSS and JSON: an editor opened on
 * junk shows errors.
 */

/**
 * @typedef {{ op: 'commit', who: string, when: string, message: string, files: Record<string, string | null> }
 *   | { op: 'branch', name: string, from?: string }
 *   | { op: 'checkout', name: string }
 *   | { op: 'merge', name: string, who: string, when: string, message: string }
 *   | { op: 'tag', name: string, who: string, when: string, message: string, at?: string }
 *   | { op: 'push', branch: string, what?: string }
 *   | { op: 'pushTags' }
 *   | { op: 'deleteBranch', name: string }
 *   | { op: 'resetBranch', name: string, to: string }
 *   | { op: 'fetch' }
 *   | { op: 'track', name: string, upstream?: string }} Step
 */

/**
 * File text written indented in this source. The indentation the template's
 * own lines share is dropped; an inserted value is taken as it is, so its
 * later lines carry the indentation they need in the file. The first line
 * break goes, trailing spaces go, runs of blank lines become one, and the
 * text ends in one `\n`.
 *
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 */
export function text(strings, ...values) {
  /** @type {number[]} */
  const starts = [];
  strings.forEach((s, i) => {
    const parts = s.split('\n');
    parts.slice(1).forEach((part, j) => {
      const endsAtValue = j === parts.length - 2 && i < values.length;
      if (part.trim() === '' && !endsAtValue) return;
      starts.push(/^ */u.exec(part)[0].length);
    });
  });
  const indent = starts.length > 0 ? Math.min(...starts) : 0;
  /** @param {string} s */
  const strip = (s) =>
    s
      .split('\n')
      .map((part, j) => (j === 0 ? part : part.slice(Math.min(indent, /^ */u.exec(part)[0].length))))
      .join('\n');
  let out = strip(strings[0]);
  values.forEach((value, i) => {
    out += String(value) + strip(strings[i + 1]);
  });
  const lines = out.replace(/^\n/u, '').split('\n').map((l) => l.replace(/\s+$/u, ''));
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\s+$/u, '')}\n`;
}

/** @returns {Step} */
const commit = (who, when, message, files) => ({ op: 'commit', who, when, message, files });
/** @returns {Step} */
const branch = (name, from) => ({ op: 'branch', name, ...(from ? { from } : {}) });
/** @returns {Step} */
const checkout = (name) => ({ op: 'checkout', name });
/** @returns {Step} */
const merge = (name, who, when) => ({ op: 'merge', name, who, when, message: `Merge branch '${name}'` });
/** @returns {Step} */
const tag = (name, who, when) => ({ op: 'tag', name, who, when, message: `Release ${name.replace(/^v/u, '')}` });
/** @returns {Step} */
const push = (branchName, what) => ({ op: 'push', branch: branchName, ...(what ? { what } : {}) });
/** @returns {Step} */
const track = (name) => ({ op: 'track', name });

// ---------------------------------------------------------------------------
// web — the React front end
// ---------------------------------------------------------------------------

/** @param {string} version @param {{ vite: string, react: string }} v */
const webPackage = (version, v) => text`
  {
    "name": "@pantry/web",
    "version": "${version}",
    "private": true,
    "type": "module",
    "scripts": {
      "dev": "vite",
      "build": "tsc -b && vite build",
      "test": "vitest run"
    },
    "dependencies": {
      "react": "^${v.react}",
      "react-dom": "^${v.react}",
      "react-router-dom": "^6.26.0"
    },
    "devDependencies": {
      "@vitejs/plugin-react": "^4.3.1",
      "typescript": "^5.6.2",
      "vite": "^${v.vite}",
      "vitest": "^2.1.1"
    }
  }
`;

/** @param {Array<[string, string]>} pages */
const routesTs = (pages) => text`
  export interface Route {
    readonly path: string;
    readonly title: string;
  }

  export const routes: readonly Route[] = [
  ${pages.map(([p, t]) => `  { path: '${p}', title: '${t}' },`).join('\n')}
  ];
`;

const viteConfig = (proxy) => text`
  import { defineConfig } from 'vite';
  import react from '@vitejs/plugin-react';

  export default defineConfig({
    plugins: [react()],
    server: {
      port: 5173,${proxy ? "\n      proxy: { '/api': 'http://localhost:8080' }," : ''}
    },
  });
`;

/**
 * web/src/cart/totals.ts as it grew, one flag per commit that changed it
 * (Ava, Diego and Noah wrote it: the blame scene shows the three). Lines stay
 * within 72 characters, so a side-by-side diff shows them whole.
 *
 * @param {{ rounding?: boolean, vat?: boolean, units?: boolean, guard?: boolean, locale?: boolean, coupons?: boolean }} f
 */
function totals(f) {
  /** @type {string[]} */
  const parts = [];
  if (f.vat) {
    parts.push(`export type Category = 'grocery' | 'household';\n${f.units ? "export type Unit = 'item' | 'kg' | 'l';\n" : ''}`);
  }
  parts.push(text`
    export interface CartLine {
      readonly name: string;${f.vat ? '\n  readonly category: Category;' : ''}${f.units ? '\n  readonly unit: Unit;' : ''}
      readonly unitCents: number;${f.rounding ? '\n  /** Items, or kilograms and litres for loose goods. */' : ''}
      readonly quantity: number;
    }
  `);
  if (f.coupons) {
    parts.push(text`
      export interface Coupon {
        readonly code: string;
        /** A share of the subtotal: 0.1 is 10 % off. */
        readonly percentOff: number;
        /** The most the coupon takes off, in cents. */
        readonly maxCents?: number;
      }
    `);
  }
  parts.push(text`
    export interface CartTotals {
      readonly subtotalCents: number;${f.coupons ? '\n  readonly discountCents: number;' : ''}
      readonly taxCents: number;
      readonly totalCents: number;
    }
  `);
  parts.push(
    f.vat
      ? text`
          /** Food takes the reduced rate, everything else the standard one. */
          const TAX_RATES: Record<Category, number> = {
            grocery: 0.07,
            household: 0.19,
          };
        `
      : 'const TAX_RATE = 0.07;\n',
  );
  if (f.rounding) {
    parts.push(text`
      /** A line's price in cents, rounded as the receipt prints it. */
      export function lineTotal(line: CartLine): number {${
        f.guard ? '\n  if (line.quantity < 0) {\n    throw new RangeError(`Negative quantity for ${line.name}`);\n  }' : ''
      }
        return Math.round(line.unitCents * line.quantity);
      }
    `);
  }
  if (f.vat) {
    parts.push(text`
      /** A line's tax in cents, at its category's rate. */
      export function lineTax(line: CartLine): number {
        return Math.round(lineTotal(line) * TAX_RATES[line.category]);
      }
    `);
  }
  if (f.locale) {
    parts.push(text`
      const priceFormat = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'EUR',
      });

      /** Cents as the user's locale writes money: 1.234,50 € in Germany. */
      export function formatCents(cents: number): string {
        return priceFormat.format(cents / 100);
      }
    `);
  }
  if (f.units) {
    parts.push(text`
      export function unitPrice(line: CartLine): string {
        const per = line.unit === 'item' ? 'each' : \`per \${line.unit}\`;
        return ${f.locale ? '`${formatCents(line.unitCents)} ${per}`' : '`${(line.unitCents / 100).toFixed(2)} ${per}`'};
      }
    `);
  }
  if (f.coupons) {
    parts.push(text`
      /** What a coupon takes off a subtotal, never more than its cap. */
      export function discountCents(subtotal: number, coupon?: Coupon) {
        if (coupon === undefined) return 0;
        const discount = Math.round(subtotal * coupon.percentOff);
        return Math.min(discount, coupon.maxCents ?? discount);
      }
    `);
    parts.push(text`
      export function cartTotals(
        lines: readonly CartLine[],
        coupon?: Coupon,
      ): CartTotals {
        const subtotal = sum(lines.map(lineTotal));
        const discount = discountCents(subtotal, coupon);
        // The discount lowers every line's taxable amount alike.
        const share = subtotal === 0 ? 0 : (subtotal - discount) / subtotal;
        const tax = sum(lines.map((l) => Math.round(lineTax(l) * share)));
        return {
          subtotalCents: subtotal,
          discountCents: discount,
          taxCents: tax,
          totalCents: subtotal - discount + tax,
        };
      }
    `);
  } else {
    parts.push(text`
      export function cartTotals(lines: readonly CartLine[]): CartTotals {
        const subtotal = sum(lines.map(${f.rounding ? 'lineTotal' : '(l) => l.unitCents * l.quantity'}));
        const tax = ${f.vat ? 'sum(lines.map(lineTax))' : 'Math.round(subtotal * TAX_RATE)'};
        return {
          subtotalCents: subtotal,
          taxCents: tax,
          totalCents: subtotal + tax,
        };
      }
    `);
  }
  parts.push(text`
    const sum = (values: readonly number[]) =>
      values.reduce((a, b) => a + b, 0);
  `);
  return parts.join('\n');
}

const totalsV1 = totals({});
const totalsV2 = totals({ rounding: true });
const totalsV3 = totals({ rounding: true, vat: true });
const totalsV4 = totals({ rounding: true, vat: true, units: true });
const totalsV5 = totals({ rounding: true, vat: true, units: true, guard: true });
const totalsV6 = totals({ rounding: true, vat: true, units: true, guard: true, locale: true });
/** The uncommitted change: coupons. */
const totalsWorking = totals({ rounding: true, vat: true, units: true, guard: true, locale: true, coupons: true });

/** @param {0 | 1 | 2} stage 1: unit prices; 2: prices in the user's locale */
const cartPage = (stage) => text`
  import { cartTotals, ${stage >= 2 ? 'formatCents, ' : ''}${stage >= 1 ? 'unitPrice, ' : ''}type CartLine } from './totals';

  export function CartPage({ lines }: { lines: readonly CartLine[] }) {
    const totals = cartTotals(lines);
    return (
      <section className="cart">
        <ul>
          {lines.map((line) => (
            <li key={line.name}>
              {line.name} × {line.quantity}${stage >= 1 ? '\n            <small>{unitPrice(line)}</small>' : ''}
            </li>
          ))}
        </ul>
        <p className="cart-total">Total: {${stage >= 2 ? 'formatCents(totals.totalCents)' : '(totals.totalCents / 100).toFixed(2)'}}</p>
      </section>
    );
  }
`;

const changelog = (versions) => `# Changelog\n\n${versions.join('\n')}`;
const webLog = {
  '1.2.1': text`
    ## 1.2.1 — 2026-09-24

    - Fixed: a shopping list with no items no longer crashes the list page.
  `,
  '1.2.0': text`
    ## 1.2.0 — 2026-09-18

    - Shopping lists work offline and sync when you are back online.
    - The cart shows unit prices.
    - Updated to Vite 7 and React 18.3.
  `,
  '1.1.0': text`
    ## 1.1.0 — 2026-08-27

    - Dark mode, following your system setting until you pick one.
    - Cart totals are rounded per line, as on the receipt.
    - Recipe images load lazily.
  `,
};

const listPage = (stage) => text`
  import type { ShoppingList } from './types';

  export function ListPage({ list }: { list: ShoppingList }) {
  ${
    stage >= 1
      ? `  if (list.items.length === 0) {\n    return <p className="empty">${stage >= 2 ? 'Nothing to buy yet. Add items, or plan a week of meals.' : 'This list is empty.'}</p>;\n  }\n`
      : ''
  }  return (
      <ul className="list">
        {list.items.map((item) => (
          <li key={item.id} className={item.done ? 'done' : undefined}>
            {item.name}
          </li>
        ))}
      </ul>
    );
  }
`;

const tokensCss = (stage) => text`
  :root {
    --surface: #ffffff;
    --text: #1d1f23;
    --accent: #2f7d5b;${stage >= 1 ? '\n  --focus-ring: 0 0 0 3px rgb(47 125 91 / 45%);' : ''}${stage >= 2 ? '\n  --muted: #6b7078;' : ''}
  }

  [data-theme='dark'] {
    --surface: #17191c;
    --text: #e6e8eb;
    --accent: #5cc99a;
  }
`;

const useTheme = (stage) => text`
  export type Theme = 'light' | 'dark';
  ${stage >= 1 ? "\nconst KEY = 'pantry.theme';\n" : ''}
  export function initialTheme(): Theme {
  ${stage >= 1 ? '  const saved = localStorage.getItem(KEY);\n  if (saved === \'light\' || saved === \'dark\') return saved;\n' : ''}${
    stage >= 2 ? "  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';" : "  return 'light';"
  }
  }

  export function applyTheme(theme: Theme): void {
    document.documentElement.dataset.theme = theme;${stage >= 1 ? '\n  localStorage.setItem(KEY, theme);' : ''}
  }
`;

/**
 * web/src/planner/WeekView.tsx. Stage 1 is the week view, 2 adds drag and
 * drop, 4 the calories; 5 is the uncommitted change, in three separate
 * places: MealCard's import, a forgotten console.log, and MealCard in use
 * (the Commit scene leaves the console.log out of the commit).
 *
 * @param {1 | 2 | 4 | 5} stage
 */
function weekView(stage) {
  const article =
    stage >= 5
      ? text`
          <MealCard
            key={meal.id}
            meal={meal}
            onRemove={() => planner.remove(meal.id)}
          />
        `
      : text`
          <article
            key={meal.id}
            className="meal"${stage >= 2 ? '\n  draggable\n  onDragStart={(e) => onDragStart(e, meal)}' : ''}
          >
            {meal.title}
          </article>
        `;
  const indent = (s, n) =>
    s
      .replace(/\n$/u, '')
      .split('\n')
      .map((l) => ' '.repeat(n) + l)
      .join('\n');
  return text`
    import { usePlanner } from './usePlanner';${stage >= 2 ? "\nimport { onDragStart, onDrop } from './dnd';" : ''}${
      stage >= 4 ? "\nimport { dayNutrition } from './nutrition';" : ''
    }${stage >= 5 ? "\nimport { MealCard } from './MealCard';" : ''}

    const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    export function WeekView({ week }: { week: string }) {
      const planner = usePlanner(week);${stage >= 5 ? "\n  console.log('WeekView', week, planner);" : ''}
      return (
        <div className="week">
          {DAYS.map((day, index) => (
            <section
              key={day}
              className="day"${stage >= 2 ? '\n          onDrop={(e) => onDrop(e, planner, index)}\n          onDragOver={(e) => e.preventDefault()}' : ''}
            >
              <h3>{day}</h3>
              {planner.mealsOn(index).map((meal) => (
    ${indent(article, 12)}
              ))}${stage >= 4 ? '\n          <footer>{dayNutrition(planner.mealsOn(index)).kcal} kcal</footer>' : ''}
            </section>
          ))}
        </div>
      );
    }
  `;
}

/**
 * web/src/planner/usePlanner.ts; stage 5, uncommitted, adds `remove`.
 *
 * @param {1 | 5} stage
 */
const usePlanner = (stage) => text`
  import { useState } from 'react';

  export interface PlannedMeal {
    readonly id: string;
    readonly title: string;
    readonly day: number;
    readonly servings: number;
  }

  export function usePlanner(week: string) {
    const [meals, setMeals] = useState<PlannedMeal[]>([]);
    return {
      week,
      mealsOn: (day: number) => meals.filter((meal) => meal.day === day),
      move: (id: string, day: number) =>
        setMeals((all) =>
          all.map((meal) => (meal.id === id ? { ...meal, day } : meal)),
        ),${stage >= 5 ? '\n    remove: (id: string) =>\n      setMeals((all) => all.filter((meal) => meal.id !== id)),' : ''}
    };
  }
`;

/** web/src/planner/toShoppingList.ts; the second version adds up names whatever their case. */
const toShoppingList = (ignoreCase) => text`
  import type { PlannedMeal } from './usePlanner';

  export interface Needed {
    readonly name: string;
    readonly amount: number;
    readonly unit: string;
  }

  export function toShoppingList(
    meals: readonly PlannedMeal[],
    ingredientsOf: (id: string) => Needed[],
  ): Needed[] {
    const total = new Map<string, Needed>();
    for (const meal of meals) {
      for (const need of ingredientsOf(meal.id)) {
        const key = \`\${${ignoreCase ? 'need.name.toLowerCase()' : 'need.name'}}/\${need.unit}\`;
        const amount = need.amount * meal.servings;
        const sum = (total.get(key)?.amount ?? 0) + amount;
        total.set(key, { ...need, amount: sum });
      }
    }
    return [...total.values()];
  }
`;

/** web/src/planner/nutrition.ts; the second version counts servings, not meals. */
const nutrition = (perServing) =>
  perServing
    ? text`
        import type { PlannedMeal } from './usePlanner';

        const KCAL_PER_SERVING = 520;

        export function dayNutrition(meals: readonly PlannedMeal[]) {
          const servings = meals.reduce((sum, meal) => sum + meal.servings, 0);
          return { kcal: servings * KCAL_PER_SERVING };
        }
      `
    : text`
        import type { PlannedMeal } from './usePlanner';

        const KCAL_PER_MEAL = 650;

        export function dayNutrition(meals: readonly PlannedMeal[]) {
          return { kcal: meals.length * KCAL_PER_MEAL };
        }
      `;

const mealCard = text`
  import type { PlannedMeal } from './usePlanner';

  export function MealCard({ meal, onRemove }: { meal: PlannedMeal; onRemove: () => void }) {
    return (
      <article className="meal-card">
        <h4>{meal.title}</h4>
        <p>{meal.servings} servings</p>
        <button type="button" onClick={onRemove} aria-label={\`Remove \${meal.title}\`}>
          ×
        </button>
      </article>
    );
  }
`;

const apiClient = (retries) => text`
  const BASE = '/api';

  export async function getJson<T>(path: string, attempts = ${retries ? 4 : 3}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(\`\${BASE}\${path}\`);
      if (response.ok) return (await response.json()) as T;
      if (attempt >= attempts || response.status < 500) {
        throw new Error(\`\${path}: \${response.status} \${response.statusText}\`);
      }
      await new Promise((resolve) => setTimeout(resolve, ${retries ? '250 * 2 ** attempt' : '500'}));
    }
  }
`;

const sync = (stage) => text`
  import { pendingEdits, markSynced } from './offlineStore';

  export async function syncLists(): Promise<number> {
    let sent = 0;
    for (const edit of await pendingEdits()) {
      ${stage >= 2 ? 'await withBackoff(() => send(edit));' : 'await send(edit);'}
      await markSynced(edit.id);
      sent++;
    }
    return sent;
  }

  async function send(edit: { id: string; listId: string }): Promise<void> {
    const response = await fetch(\`/api/lists/\${edit.listId}/edits\`, { method: 'POST', body: JSON.stringify(edit) });
    if (!response.ok) throw new Error(\`sync failed: \${response.status}\`);
  }
  ${
    stage >= 2
      ? '\nasync function withBackoff(task: () => Promise<void>, attempts = 5): Promise<void> {\n  for (let attempt = 1; ; attempt++) {\n    try {\n      return await task();\n    } catch (error) {\n      if (attempt >= attempts) throw error;\n      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));\n    }\n  }\n}\n'
      : ''
  }
`;

const recipeList = (stage) => text`
  import { RecipeCard } from './RecipeCard';
  import { searchRecipes, type Recipe } from './search';${stage >= 1 ? "\nimport { useHotkeys } from '../hooks/useHotkeys';" : ''}

  export function RecipeList({ recipes, query }: { recipes: readonly Recipe[]; query: string }) {
    const found = searchRecipes(recipes, query);${stage >= 1 ? "\n  useHotkeys({ '/': () => document.getElementById('recipe-search')?.focus() });" : ''}${
      stage >= 2 ? '\n  if (found.length === 0) return <p className="empty">No recipes match “{query}”.</p>;' : ''
    }
    return (
      <div className="recipes">
        {found.map((recipe) => (
          <RecipeCard key={recipe.id} recipe={recipe} />
        ))}
      </div>
    );
  }
`;

const recipeCard = (stage) => text`
  import type { Recipe } from './search';

  export function RecipeCard({ recipe }: { recipe: Recipe }) {
    return (
      <article className="recipe-card"${stage >= 1 ? ' tabIndex={0}' : ''}>
        <img src={recipe.imageUrl} alt="" loading="lazy" />
        <h3>{recipe.title}</h3>
        <p>{recipe.minutes} min</p>
      </article>
    );
  }
`;

const webInitial = {
  'package.json': webPackage('1.0.0', { vite: '5.4.0', react: '18.2.0' }),
  'README.md': text`
    # Pantry — web

    The Pantry web app: recipes, a shopping cart and lists.

    \`\`\`sh
    npm install
    npm run dev
    \`\`\`
  `,
  'index.html': text`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>Pantry</title>
      </head>
      <body>
        <div id="root"></div>
        <script type="module" src="/src/main.tsx"></script>
      </body>
    </html>
  `,
  'tsconfig.json': text`
    {
      "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "Bundler",
        "jsx": "react-jsx",
        "strict": true,
        "noEmit": true
      },
      "include": ["src"]
    }
  `,
  'vite.config.ts': viteConfig(false),
  'src/main.tsx': text`
    import { createRoot } from 'react-dom/client';
    import { App } from './App';

    createRoot(document.getElementById('root')!).render(<App />);
  `,
  'src/App.tsx': text`
    export function App() {
      return <h1>Pantry</h1>;
    }
  `,
};

/** @type {Step[]} */
const web = [
  commit('noah', '2026-08-03 09:40', 'Scaffold the Vite + React app', webInitial),
  commit('noah', '2026-08-05 14:05', 'Add routing and the app shell', {
    'src/App.tsx': text`
      import { Shell } from './layout/Shell';
      import { routes } from './routes';

      export function App() {
        return <Shell routes={routes} />;
      }
    `,
    'src/routes.ts': routesTs([
      ['/', 'Recipes'],
      ['/lists', 'Lists'],
    ]),
    'src/layout/Shell.tsx': text`
      import type { Route } from '../routes';

      export function Shell({ routes }: { routes: readonly Route[] }) {
        return (
          <nav className="shell">
            {routes.map((route) => (
              <a key={route.path} href={route.path}>
                {route.title}
              </a>
            ))}
          </nav>
        );
      }
    `,
    'src/lists/types.ts': text`
      export interface ShoppingList {
        readonly id: string;
        readonly name: string;
        readonly items: readonly { id: string; name: string; done: boolean }[];
      }
    `,
    'src/lists/ListPage.tsx': listPage(0),
  }),
  commit('zara', '2026-08-07 11:20', 'Add the recipe list with search', {
    'src/recipes/search.ts': text`
      export interface Recipe {
        readonly id: string;
        readonly title: string;
        readonly minutes: number;
        readonly imageUrl: string;
        readonly tags: readonly string[];
      }

      export function searchRecipes(recipes: readonly Recipe[], query: string): Recipe[] {
        const words = query.toLowerCase().split(/\\s+/).filter(Boolean);
        return recipes.filter((recipe) =>
          words.every((word) => recipe.title.toLowerCase().includes(word) || recipe.tags.includes(word)),
        );
      }
    `,
    'src/recipes/RecipeList.tsx': recipeList(0),
    'src/recipes/RecipeCard.tsx': text`
      import type { Recipe } from './search';

      export function RecipeCard({ recipe }: { recipe: Recipe }) {
        return (
          <article className="recipe-card">
            <img src={recipe.imageUrl} alt="" />
            <h3>{recipe.title}</h3>
            <p>{recipe.minutes} min</p>
          </article>
        );
      }
    `,
  }),
  commit('ava', '2026-08-10 10:05', 'Add the shopping cart with totals', {
    'src/cart/totals.ts': totalsV1,
    'src/cart/CartPage.tsx': cartPage(0),
    'src/routes.ts': routesTs([
      ['/', 'Recipes'],
      ['/lists', 'Lists'],
      ['/cart', 'Cart'],
    ]),
  }),
  commit('noah', '2026-08-12 16:30', 'Add an API client that retries server errors', {
    'src/api/client.ts': apiClient(false),
  }),
  tag('v1.0.0', 'noah', '2026-08-14 09:00'),

  branch('bugfix/cart-rounding'),
  branch('feature/dark-mode'),
  checkout('bugfix/cart-rounding'),
  commit(
    'ava',
    '2026-08-18 09:15',
    'Round cart totals per line, not per order\n\nA line of 0.333 kg was rounded only in the order\ntotal, so the receipt and the total could be a\ncent apart. Fixes #23.',
    {
      'src/cart/totals.ts': totalsV2,
      'src/cart/totals.test.ts': text`
        import { describe, expect, it } from 'vitest';
        import { cartTotals } from './totals';

        describe('cartTotals', () => {
          it('rounds each line the way the receipt does', () => {
            const totals = cartTotals([{ name: 'Cheese', unitCents: 1999, quantity: 0.333 }]);
            expect(totals.subtotalCents).toBe(666);
          });
        });
      `,
    },
  ),
  checkout('feature/dark-mode'),
  commit('zara', '2026-08-19 15:40', 'Add theme tokens and a dark palette', {
    'src/theme/tokens.css': tokensCss(0),
    'src/theme/useTheme.ts': useTheme(0),
  }),
  commit('zara', '2026-08-21 10:10', 'Remember the chosen theme', { 'src/theme/useTheme.ts': useTheme(1) }),
  commit('zara', '2026-08-22 13:55', 'Follow prefers-color-scheme on the first visit', { 'src/theme/useTheme.ts': useTheme(2) }),
  checkout('main'),
  commit('diego', '2026-08-19 18:25', 'Load recipe images lazily', { 'src/recipes/RecipeCard.tsx': recipeCard(0) }),
  merge('bugfix/cart-rounding', 'noah', '2026-08-20 09:30'),
  merge('feature/dark-mode', 'ava', '2026-08-25 11:45'),
  commit('diego', '2026-08-27 15:00', 'Update the changelog for 1.1.0', {
    'CHANGELOG.md': changelog([webLog['1.1.0']]),
    'package.json': webPackage('1.1.0', { vite: '5.4.0', react: '18.2.0' }),
  }),
  tag('v1.1.0', 'diego', '2026-08-27 15:05'),
  commit(
    'diego',
    '2026-08-29 10:35',
    'Apply the reduced VAT rate to groceries\n\nFood is taxed at 7 % and everything else at\n19 %, so each cart line now knows its category.',
    { 'src/cart/totals.ts': totalsV3 },
  ),

  branch('feature/recipe-import'),
  branch('feature/offline-lists'),
  checkout('feature/recipe-import'),
  commit('samir', '2026-09-03 10:00', 'Parse schema.org Recipe JSON-LD', {
    'src/recipes/import/jsonld.ts': text`
      export interface ImportedRecipe {
        readonly title: string;
        readonly minutes: number;
        readonly ingredients: readonly string[];
      }

      /** Reads the first schema.org Recipe in a page's JSON-LD blocks. */
      export function recipeFromJsonLd(blocks: readonly unknown[]): ImportedRecipe | undefined {
        for (const block of blocks) {
          const node = block as { '@type'?: string; name?: string; totalTime?: string; recipeIngredient?: string[] };
          if (node['@type'] !== 'Recipe' || !node.name) continue;
          return { title: node.name, minutes: isoMinutes(node.totalTime), ingredients: node.recipeIngredient ?? [] };
        }
        return undefined;
      }

      function isoMinutes(duration = 'PT0M'): number {
        const match = /PT(?:(\\d+)H)?(?:(\\d+)M)?/.exec(duration);
        return Number(match?.[1] ?? 0) * 60 + Number(match?.[2] ?? 0);
      }
    `,
  }),
  commit('samir', '2026-09-05 16:20', 'Import a recipe from a pasted link', {
    'src/recipes/import/ImportDialog.tsx': text`
      import { useState } from 'react';

      export function ImportDialog({ onImport }: { onImport: (url: string) => void }) {
        const [url, setUrl] = useState('');
        return (
          <form onSubmit={(e) => (e.preventDefault(), onImport(url))}>
            <label>
              Recipe link <input value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <button type="submit">Import</button>
          </form>
        );
      }
    `,
  }),
  commit('samir', '2026-09-09 11:45', 'Map imported ingredients to our units', {
    'src/recipes/import/units.ts': text`
      const UNITS: Record<string, string> = { g: 'g', gram: 'g', grams: 'g', kg: 'kg', ml: 'ml', l: 'l', cup: 'cup', cups: 'cup' };

      export function parseAmount(line: string): { amount: number; unit: string; name: string } | undefined {
        const match = /^([\\d.]+)\\s*(\\w+)\\s+(.*)$/.exec(line.trim());
        if (!match || !(match[2].toLowerCase() in UNITS)) return undefined;
        return { amount: Number(match[1]), unit: UNITS[match[2].toLowerCase()], name: match[3] };
      }
    `,
  }),
  checkout('feature/offline-lists'),
  commit('diego', '2026-09-04 09:50', 'Keep shopping lists in IndexedDB', {
    'src/lists/offlineStore.ts': text`
      export interface PendingEdit {
        readonly id: string;
        readonly listId: string;
      }

      const DB = 'pantry-lists';

      function open(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open(DB, 1);
          request.onupgradeneeded = () => request.result.createObjectStore('edits', { keyPath: 'id' });
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }

      export async function pendingEdits(): Promise<PendingEdit[]> {
        const db = await open();
        return new Promise((resolve) => {
          const request = db.transaction('edits').objectStore('edits').getAll();
          request.onsuccess = () => resolve(request.result as PendingEdit[]);
        });
      }

      export async function markSynced(id: string): Promise<void> {
        const db = await open();
        db.transaction('edits', 'readwrite').objectStore('edits').delete(id);
      }
    `,
  }),
  commit('diego', '2026-09-08 17:05', 'Sync offline edits when the app is back online', { 'src/lists/sync.ts': sync(1) }),
  checkout('main'),
  commit('noah', '2026-09-06 12:15', 'Update to Vite 7 and React 18.3', {
    'package.json': webPackage('1.1.0', { vite: '7.1.0', react: '18.3.1' }),
  }),
  commit('zara', '2026-09-10 14:30', 'Show a focus ring on recipe cards', {
    'src/recipes/RecipeCard.tsx': recipeCard(1),
    'src/theme/tokens.css': tokensCss(1),
  }),
  merge('feature/offline-lists', 'diego', '2026-09-12 10:20'),
  branch('spike/service-worker'),
  commit('ava', '2026-09-16 15:10', 'Show unit prices in the cart', {
    'src/cart/totals.ts': totalsV4,
    'src/cart/CartPage.tsx': cartPage(1),
  }),
  commit('noah', '2026-09-18 11:00', 'Release 1.2.0', {
    'CHANGELOG.md': changelog([webLog['1.2.0'], webLog['1.1.0']]),
    'package.json': webPackage('1.2.0', { vite: '7.1.0', react: '18.3.1' }),
  }),
  tag('v1.2.0', 'noah', '2026-09-18 11:05'),
  branch('release/1.2'),
  checkout('release/1.2'),
  commit('noah', '2026-09-24 09:25', 'Fix the list page crashing on an empty list', {
    'src/lists/ListPage.tsx': listPage(1),
    'CHANGELOG.md': changelog([webLog['1.2.1'], webLog['1.2.0'], webLog['1.1.0']]),
    'package.json': webPackage('1.2.1', { vite: '7.1.0', react: '18.3.1' }),
  }),
  tag('v1.2.1', 'noah', '2026-09-24 09:30'),
  checkout('spike/service-worker'),
  commit('ava', '2026-09-22 17:40', 'Try a service worker for offline recipes', {
    'src/sw/serviceWorker.ts': text`
      const CACHE = 'pantry-recipes-v1';

      export function registerServiceWorker(): void {
        if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
      }

      export async function cacheRecipe(url: string): Promise<void> {
        const cache = await caches.open(CACHE);
        await cache.add(url);
      }
    `,
  }),
  checkout('main'),
  merge('release/1.2', 'noah', '2026-09-25 10:00'),
  commit('zara', '2026-09-30 13:15', 'Focus recipe search with the / key', {
    'src/hooks/useHotkeys.ts': text`
      import { useEffect } from 'react';

      export function useHotkeys(keys: Record<string, () => void>): void {
        useEffect(() => {
          const onKey = (event: KeyboardEvent) => {
            if (event.target instanceof HTMLInputElement) return;
            keys[event.key]?.();
          };
          window.addEventListener('keydown', onKey);
          return () => window.removeEventListener('keydown', onKey);
        }, [keys]);
      }
    `,
    'src/recipes/RecipeList.tsx': recipeList(1),
  }),
  commit('noah', '2026-10-02 09:05', 'Reject negative quantities in the cart', { 'src/cart/totals.ts': totalsV5 }),
  commit('ava', '2026-10-07 14:50', 'Format prices in the user’s locale', {
    'src/cart/totals.ts': totalsV6,
    'src/cart/CartPage.tsx': cartPage(2),
  }),
  branch('feature/meal-planner'),
  commit('diego', '2026-10-09 11:30', 'Retry failed list syncs with exponential backoff', {
    'src/lists/sync.ts': sync(2),
    'src/api/client.ts': apiClient(true),
  }),
  commit('zara', '2026-10-13 16:00', 'Friendlier empty states', {
    'src/lists/ListPage.tsx': listPage(2),
    'src/recipes/RecipeList.tsx': recipeList(2),
    'src/theme/tokens.css': tokensCss(2),
  }),
  checkout('feature/meal-planner'),
  commit('ava', '2026-10-14 10:20', 'Add a week view to plan meals', {
    'src/planner/WeekView.tsx': weekView(1),
    'src/planner/usePlanner.ts': usePlanner(1),
    'src/routes.ts': routesTs([
      ['/', 'Recipes'],
      ['/planner', 'Planner'],
      ['/lists', 'Lists'],
      ['/cart', 'Cart'],
    ]),
  }),
  commit('ava', '2026-10-16 15:35', 'Drag meals between days', {
    'src/planner/WeekView.tsx': weekView(2),
    'src/planner/dnd.ts': text`
      import type { DragEvent } from 'react';
      import type { PlannedMeal } from './usePlanner';

      export function onDragStart(event: DragEvent, meal: PlannedMeal): void {
        event.dataTransfer.setData('text/plain', meal.id);
      }

      export function onDrop(event: DragEvent, planner: { move: (id: string, day: number) => void }, day: number): void {
        planner.move(event.dataTransfer.getData('text/plain'), day);
      }
    `,
  }),
  commit(
    'ava',
    '2026-10-21 11:10',
    'Make a shopping list from the week’s meals\n\nThe ingredients of every planned meal are added\nup per unit and scaled by the servings; what is\nalready in the pantry is left out.',
    { 'src/planner/toShoppingList.ts': toShoppingList(false) },
  ),
  // The next commits are what Ava tidies up in the rebase scene: a fix of the
  // commit before (a fixup) and a follow-up of the calories (a squash).
  commit('ava', '2026-10-21 16:45', 'Ignore case when adding up ingredients', {
    'src/planner/toShoppingList.ts': toShoppingList(true),
  }),
  commit('ava', '2026-10-23 17:45', 'Show the calories of each day', {
    'src/planner/WeekView.tsx': weekView(4),
    'src/planner/nutrition.ts': nutrition(false),
  }),
  commit('ava', '2026-10-24 09:30', 'Count calories per serving, not per meal', {
    'src/planner/nutrition.ts': nutrition(true),
  }),
  checkout('main'),
  commit('diego', '2026-10-28 10:40', 'Add the pantry inventory page', {
    'src/pantry/PantryPage.tsx': text`
      export interface PantryItem {
        readonly name: string;
        readonly amount: number;
        readonly unit: string;
        readonly bestBefore?: string;
      }

      export function PantryPage({ items }: { items: readonly PantryItem[] }) {
        return (
          <table className="pantry">
            <tbody>
              {items.map((item) => (
                <tr key={item.name}>
                  <td>{item.name}</td>
                  <td>
                    {item.amount} {item.unit}
                  </td>
                  <td>{item.bestBefore ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
    `,
    'src/routes.ts': routesTs([
      ['/', 'Recipes'],
      ['/pantry', 'Pantry'],
      ['/lists', 'Lists'],
      ['/cart', 'Cart'],
    ]),
  }),
  commit('zara', '2026-11-04 12:25', 'Translate the app into German', {
    'src/i18n/de.json': text`
      {
        "recipes": "Rezepte",
        "lists": "Einkaufslisten",
        "cart": "Warenkorb",
        "pantry": "Vorratskammer",
        "empty.list": "Noch nichts zu kaufen."
      }
    `,
    'src/i18n/index.ts': text`
      import de from './de.json';

      const catalogs: Record<string, Record<string, string>> = { de };

      export function t(key: string, locale = navigator.language.slice(0, 2)): string {
        return catalogs[locale]?.[key] ?? key;
      }
    `,
  }),

  // Origin gets main with the two newest commits, the planner as it was four
  // commits ago, Samir's import branch, the release branch and the tags…
  push('main', 'main'),
  push('feature/meal-planner', 'feature/meal-planner~4'),
  push('feature/recipe-import', 'feature/recipe-import'),
  push('feature/offline-lists', 'feature/offline-lists'),
  push('release/1.2', 'release/1.2'),
  { op: 'pushTags' },
  // …then the local repository falls behind on main and keeps working on the planner.
  checkout('feature/meal-planner'),
  { op: 'resetBranch', name: 'main', to: 'main~2' },
  { op: 'deleteBranch', name: 'feature/recipe-import' },
  { op: 'deleteBranch', name: 'bugfix/cart-rounding' },
  { op: 'deleteBranch', name: 'feature/dark-mode' },
  { op: 'fetch' },
  track('main'),
  track('feature/meal-planner'),
  track('feature/offline-lists'),
  track('release/1.2'),
];

// ---------------------------------------------------------------------------
// api — the server
// ---------------------------------------------------------------------------

/** @param {{ routes: string[], logging?: boolean, rateLimit?: boolean }} o */
const serverTs = (o) => text`
  import Fastify from 'fastify';
  ${o.routes.map((r) => `import { ${r}Routes } from './routes/${r}.js';`).join('\n')}${o.logging ? "\nimport { requestLogging } from './middleware/logging.js';" : ''}${
    o.rateLimit ? "\nimport { rateLimit } from './middleware/rateLimit.js';" : ''
  }

  const app = Fastify({ logger: true });
  ${o.logging ? '\napp.addHook(\'onRequest\', requestLogging);' : ''}${o.rateLimit ? "\napp.addHook('onRequest', rateLimit({ path: '/auth/login', perMinute: 10 }));" : ''}
  app.get('/health', async () => ({ ok: true }));
  ${o.routes.map((r) => `await app.register(${r}Routes, { prefix: '/${r}' });`).join('\n')}

  await app.listen({ port: Number(process.env.PORT ?? 8080), host: '0.0.0.0' });
`;

const recipesRoute = (stage) => text`
  import type { FastifyInstance } from 'fastify';
  import { db } from '../db/client.js';${stage >= 1 ? "\nimport { readBody, recipeInput } from '../validate.js';" : ''}${
    stage >= 2 ? "\nimport { searchRecipes } from '../db/queries.js';" : ''
  }

  export async function recipesRoutes(app: FastifyInstance): Promise<void> {
    app.get('/', async (request) => {
      const { q = '' } = request.query as { q?: string; page?: string };${
        stage >= 2
          ? '\n    const page = Math.max(1, Number((request.query as { page?: string }).page ?? 1));\n    return searchRecipes(q, { limit: 20, offset: (page - 1) * 20 });'
          : "\n    const { rows } = await db.query('select * from recipes where title ilike $1', [`%${q}%`]);\n    return rows;"
      }
    });

    app.post('/', async (request, reply) => {
      const recipe = ${stage >= 1 ? 'readBody(request, recipeInput)' : 'request.body as { title: string; minutes: number }'};
      await db.query('insert into recipes (title, minutes) values ($1, $2)', [recipe.title, recipe.minutes]);
      return reply.code(201).send();
    });
  }
`;

const plansRoute = (stage) => text`
  import type { FastifyInstance } from 'fastify';
  import { db } from '../db/client.js';

  interface PlannedMealInput {
    readonly day: number;
    readonly slot: 'breakfast' | 'lunch' | 'dinner';
    readonly recipeId: string;
    readonly servings: number;${stage >= 3 ? '\n  readonly note?: string;' : ''}
  }
  ${
    stage >= 2
      ? "\nconst WEEK = /^\\d{4}-W\\d{2}$/;\n\nfunction problemWith(meal: PlannedMealInput): string | undefined {\n  if (meal.day < 0 || meal.day > 6) return 'day must be 0 (Monday) to 6 (Sunday)';\n  if (!Number.isInteger(meal.servings) || meal.servings < 1) return 'servings must be a whole number above 0';\n  return undefined;\n}\n"
      : ''
  }
  export async function plansRoutes(app: FastifyInstance): Promise<void> {
    app.get('/:week', async (request) => {
      const { week } = request.params as { week: string };
      const { rows } = await db.query('select * from planned_meals where week = $1 order by day, slot', [week]);
      return rows;
    });

    app.post('/:week', async (request, reply) => {
      const { week } = request.params as { week: string };
      const meal = request.body as PlannedMealInput;${
        stage >= 2
          ? "\n    const problem = WEEK.test(week) ? problemWith(meal) : 'week must look like 2026-W43';\n    if (problem) return reply.code(400).send({ error: problem });"
          : ''
      }
      await db.query(
        'insert into planned_meals (week, day, slot, recipe_id, servings${stage >= 3 ? ', note' : ''}) values ($1, $2, $3, $4, $5${stage >= 3 ? ', $6' : ''})',
        [week, meal.day, meal.slot, meal.recipeId, meal.servings${stage >= 3 ? ', meal.note ?? null' : ''}],
      );
      return reply.code(201).send();
    });${
      stage >= 3
        ? "\n\n  app.delete('/:week/:id', async (request, reply) => {\n    const { week, id } = request.params as { week: string; id: string };\n    await db.query('delete from planned_meals where week = $1 and id = $2', [week, id]);\n    return reply.code(204).send();\n  });"
        : ''
    }
  }
`;

const rateLimitTs = (retryAfter) => text`
  import type { FastifyReply, FastifyRequest } from 'fastify';

  /** A fixed window per client address: at most \`perMinute\` requests to \`path\`. */
  export function rateLimit(options: { path: string; perMinute: number }) {
    const hits = new Map<string, { count: number; resetAt: number }>();
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.url !== options.path) return;
      const now = Date.now();
      const entry = hits.get(request.ip) ?? { count: 0, resetAt: now + 60_000 };
      if (now > entry.resetAt) Object.assign(entry, { count: 0, resetAt: now + 60_000 });
      entry.count++;
      hits.set(request.ip, entry);
      if (entry.count > options.perMinute) {${retryAfter ? "\n      reply.header('Retry-After', Math.ceil((entry.resetAt - now) / 1000));" : ''}
        return reply.code(429).send({ error: 'Too many login attempts' });
      }
    };
  }
`;

const searchSql = (ranked) => text`
  -- Recipes whose title or tags match every word of the query.
  select r.id, r.title, r.minutes
  from recipes r
  where r.search @@ plainto_tsquery('simple', $1)
  order by ${ranked ? "(r.title ilike '%' || $1 || '%') desc, ts_rank(r.search, plainto_tsquery('simple', $1)) desc" : 'r.title'}
  limit $2 offset $3;
`;

/** @type {Step[]} */
const api = [
  commit('samir', '2026-08-04 10:30', 'Scaffold the API server', {
    'package.json': text`
      {
        "name": "@pantry/api",
        "version": "1.0.0",
        "private": true,
        "type": "module",
        "scripts": {
          "dev": "tsx watch src/server.ts",
          "build": "tsc -p .",
          "migrate": "node scripts/migrate.js"
        },
        "dependencies": {
          "fastify": "^4.28.1",
          "pg": "^8.12.0"
        },
        "devDependencies": {
          "tsx": "^4.19.0",
          "typescript": "^5.6.2"
        }
      }
    `,
    'tsconfig.json': text`
      {
        "compilerOptions": {
          "target": "ES2022",
          "module": "NodeNext",
          "strict": true,
          "outDir": "dist"
        },
        "include": ["src"]
      }
    `,
    'README.md': text`
      # Pantry — API

      The HTTP API behind the Pantry apps. \`npm run dev\` starts it on port 8080.
    `,
    'src/server.ts': serverTs({ routes: [] }),
  }),
  commit('samir', '2026-08-06 15:45', 'Add the Postgres client and migrations', {
    'src/db/client.ts': text`
      import pg from 'pg';

      export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    `,
    'src/db/migrations/0001_init.sql': text`
      create table recipes (
        id uuid primary key default gen_random_uuid(),
        title text not null,
        minutes integer not null check (minutes > 0),
        search tsvector generated always as (to_tsvector('simple', title)) stored
      );
    `,
  }),
  commit('diego', '2026-08-11 09:20', 'Add the /recipes endpoints', {
    'src/routes/recipes.ts': recipesRoute(0),
    'src/server.ts': serverTs({ routes: ['recipes'] }),
  }),
  commit('diego', '2026-08-13 14:10', 'Add the /lists endpoints', {
    'src/routes/lists.ts': text`
      import type { FastifyInstance } from 'fastify';
      import { db } from '../db/client.js';

      export async function listsRoutes(app: FastifyInstance): Promise<void> {
        app.get('/:id', async (request) => {
          const { id } = request.params as { id: string };
          const { rows } = await db.query('select * from list_items where list_id = $1 order by position', [id]);
          return rows;
        });
      }
    `,
    'src/db/migrations/0002_lists.sql': text`
      create table list_items (
        id uuid primary key default gen_random_uuid(),
        list_id uuid not null,
        name text not null,
        position integer not null,
        done boolean not null default false
      );
    `,
    'src/server.ts': serverTs({ routes: ['recipes', 'lists'] }),
  }),
  tag('v1.0.0', 'samir', '2026-08-14 10:00'),
  branch('feature/rate-limit'),
  checkout('feature/rate-limit'),
  commit('samir', '2026-08-20 11:00', 'Rate-limit login attempts per address', {
    'src/middleware/rateLimit.ts': rateLimitTs(false),
    'src/server.ts': serverTs({ routes: ['recipes', 'lists'], rateLimit: true }),
  }),
  commit('samir', '2026-08-22 16:40', 'Send Retry-After with 429 responses', { 'src/middleware/rateLimit.ts': rateLimitTs(true) }),
  checkout('main'),
  commit('mei', '2026-08-21 09:30', 'Validate request bodies', {
    'src/validate.ts': text`
      import type { FastifyRequest } from 'fastify';

      export type Check<T> = (value: unknown) => T;

      export const recipeInput: Check<{ title: string; minutes: number }> = (value) => {
        const body = value as { title?: unknown; minutes?: unknown };
        if (typeof body.title !== 'string' || body.title.trim() === '') throw new Error('title is required');
        if (typeof body.minutes !== 'number' || body.minutes <= 0) throw new Error('minutes must be above 0');
        return { title: body.title.trim(), minutes: body.minutes };
      };

      export function readBody<T>(request: FastifyRequest, check: Check<T>): T {
        return check(request.body);
      }
    `,
    'src/routes/recipes.ts': recipesRoute(1),
  }),
  merge('feature/rate-limit', 'samir', '2026-08-26 10:15'),
  commit('diego', '2026-09-04 14:25', 'Paginate recipe search', {
    'src/routes/recipes.ts': recipesRoute(2),
    'src/db/queries.ts': text`
      import { readFileSync } from 'node:fs';
      import { db } from './client.js';

      const SEARCH = readFileSync(new URL('./queries/searchRecipes.sql', import.meta.url), 'utf8');

      export async function searchRecipes(q: string, page: { limit: number; offset: number }) {
        const { rows } = await db.query(SEARCH, [q, page.limit, page.offset]);
        return rows;
      }
    `,
    'src/db/queries/searchRecipes.sql': searchSql(false),
  }),
  branch('fix/search-ranking'),
  checkout('fix/search-ranking'),
  commit('mei', '2026-09-11 10:50', 'Rank title matches above tag matches', {
    'src/db/queries/searchRecipes.sql': searchSql(true),
  }),
  checkout('main'),
  commit('samir', '2026-09-15 13:35', 'Log requests with a trace id', {
    'src/middleware/logging.ts': text`
      import { randomUUID } from 'node:crypto';
      import type { FastifyRequest } from 'fastify';

      export async function requestLogging(request: FastifyRequest): Promise<void> {
        const traceId = (request.headers['x-trace-id'] as string | undefined) ?? randomUUID();
        request.log = request.log.child({ traceId });
        request.log.info({ method: request.method, url: request.url }, 'request');
      }
    `,
    'src/server.ts': serverTs({ routes: ['recipes', 'lists'], rateLimit: true, logging: true }),
  }),
  merge('fix/search-ranking', 'diego', '2026-09-17 09:10'),
  tag('v1.1.0', 'diego', '2026-09-18 10:00'),
  branch('feature/webhooks'),
  commit('samir', '2026-10-08 11:15', 'Add the meal plan tables', {
    'src/db/migrations/0003_meal_plans.sql': text`
      create table planned_meals (
        id uuid primary key default gen_random_uuid(),
        week text not null,
        day smallint not null check (day between 0 and 6),
        slot text not null,
        recipe_id uuid not null references recipes (id),
        servings smallint not null
      );
    `,
  }),
  commit('ava', '2026-10-15 16:05', 'Add the /plans endpoints', {
    'src/routes/plans.ts': plansRoute(1),
    'src/server.ts': serverTs({ routes: ['recipes', 'lists', 'plans'], rateLimit: true, logging: true }),
  }),
  checkout('feature/webhooks'),
  commit('samir', '2026-10-27 15:20', 'Sign webhook payloads with HMAC-SHA256', {
    'src/webhooks/sign.ts': text`
      import { createHmac } from 'node:crypto';

      export function signature(secret: string, body: string): string {
        return \`sha256=\${createHmac('sha256', secret).update(body).digest('hex')}\`;
      }
    `,
  }),
  commit('samir', '2026-11-03 10:05', 'Retry webhook deliveries for a day', {
    'src/webhooks/deliver.ts': text`
      import { signature } from './sign.js';

      const DELAYS_MINUTES = [1, 5, 30, 120, 720, 1440];

      export async function deliver(url: string, secret: string, body: string, attempt = 0): Promise<number | undefined> {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-pantry-signature': signature(secret, body) },
          body,
        });
        if (response.ok) return undefined;
        return DELAYS_MINUTES[attempt];
      }
    `,
  }),
  checkout('main'),
  push('main', 'main'),
  push('feature/webhooks', 'feature/webhooks'),
  commit('ava', '2026-10-20 10:40', 'Check plan weeks, days and servings', { 'src/routes/plans.ts': plansRoute(2) }),
  { op: 'pushTags' },
  { op: 'deleteBranch', name: 'feature/rate-limit' },
  { op: 'deleteBranch', name: 'fix/search-ranking' },
  { op: 'deleteBranch', name: 'feature/webhooks' },
  { op: 'fetch' },
  track('main'),
];

// ---------------------------------------------------------------------------
// shared — types and helpers both apps use
// ---------------------------------------------------------------------------

/**
 * shared/src/money.ts as it grew. `multiply` and `format` are later commits;
 * `side` is main's change (`ours`: a locale, JPY, subtract) or
 * feature/currency-display's (`theirs`: compact amounts and CHF, then
 * `isZero`). Merging the two conflicts twice — the `Currency` line and
 * `formatMoney` — and merges the rest cleanly. Lines stay within 48
 * characters: the merge scene shows the file three times side by side.
 *
 * @param {{ multiply?: boolean, format?: boolean, side?: 'ours' | 'theirs', isZero?: boolean }} f
 */
function moneyTs(f) {
  const added = f.side === 'ours' ? " | 'JPY'" : f.side === 'theirs' ? " | 'CHF'" : '';
  /** @type {string[]} */
  const parts = [
    text`
      /** Money in cents, so sums never drift. */
      export interface Money {
        readonly cents: number;
        readonly currency: Currency;
      }
    `,
    `export type Currency = 'EUR' | 'USD'${added};\n`,
    text`
      export function money(
        amount: number,
        currency: Currency = 'EUR',
      ): Money {
        const cents = Math.round(amount * 100);
        return { cents, currency };
      }
    `,
  ];
  if (f.format && f.side === 'ours') {
    parts.push(text`
      /** The amount as \`locale\` writes money. */
      export function formatMoney(
        m: Money,
        locale = 'en-US',
      ): string {
        return new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: m.currency,
        }).format(m.cents / 100);
      }
    `);
  } else if (f.format && f.side === 'theirs') {
    parts.push(text`
      export interface FormatOptions {
        /** €1.2K rather than €1,234.50 */
        readonly compact?: boolean;
      }

      export function formatMoney(
        m: Money,
        { compact = false }: FormatOptions = {},
      ): string {
        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: m.currency,
          notation: compact ? 'compact' : 'standard',
        }).format(m.cents / 100);
      }
    `);
  } else if (f.format) {
    parts.push(text`
      export function formatMoney(m: Money): string {
        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: m.currency,
        }).format(m.cents / 100);
      }
    `);
  }
  parts.push(
    text`
      export function add(a: Money, b: Money): Money {
        assertSameCurrency(a, b);
        const cents = a.cents + b.cents;
        return { cents, currency: a.currency };
      }
    `
  );
  if (f.side === 'ours') {
    parts.push(text`
      export function subtract(a: Money, b: Money) {
        assertSameCurrency(a, b);
        const cents = a.cents - b.cents;
        return { cents, currency: a.currency };
      }
    `);
  }
  if (f.multiply) {
    parts.push(text`
      /** Multiplies with banker's rounding. */
      export function multiply(m: Money, by: number) {
        const exact = m.cents * by;
        const floor = Math.floor(exact);
        const even = floor + (floor % 2);
        const half = exact - floor === 0.5;
        return {
          cents: half ? even : Math.round(exact),
          currency: m.currency,
        };
      }
    `);
  }
  parts.push(text`
    function assertSameCurrency(a: Money, b: Money) {
      if (a.currency !== b.currency) {
        const pair = \`\${a.currency} and \${b.currency}\`;
        throw new Error(\`Cannot combine \${pair}\`);
      }
    }
  `);
  if (f.isZero) {
    parts.push(text`
      export function isZero(m: Money): boolean {
        return m.cents === 0;
      }
    `);
  }
  return parts.join('\n');
}

const moneyV1 = moneyTs({});
const moneyV2 = moneyTs({ multiply: true });
/** The merge base of main and feature/currency-display. */
const moneyV3 = moneyTs({ multiply: true, format: true });
/** main: a locale for formatMoney, JPY, and subtract. */
const moneyOurs = moneyTs({ multiply: true, format: true, side: 'ours' });
/** feature/currency-display, first commit: compact amounts and CHF. */
const moneyTheirs1 = moneyTs({ multiply: true, format: true, side: 'theirs' });
/** feature/currency-display, second commit: isZero. */
const moneyTheirs2 = moneyTs({ multiply: true, format: true, side: 'theirs', isZero: true });

const sharedIndex = (mods) => `${mods.map((m) => `export * from './${m}.js';`).join('\n')}\n`;

/** @type {Step[]} */
const shared = [
  commit('mei', '2026-08-04 08:45', 'Create the shared package with a Money type', {
    'package.json': text`
      {
        "name": "@pantry/shared",
        "version": "0.1.0",
        "private": true,
        "type": "module",
        "main": "dist/index.js",
        "types": "dist/index.d.ts",
        "scripts": {
          "build": "tsc -p .",
          "test": "vitest run"
        },
        "devDependencies": {
          "typescript": "^5.6.2",
          "vitest": "^2.1.1"
        }
      }
    `,
    'tsconfig.json': text`
      {
        "compilerOptions": {
          "target": "ES2022",
          "module": "NodeNext",
          "strict": true,
          "declaration": true,
          "outDir": "dist"
        },
        "include": ["src"]
      }
    `,
    'README.md': text`
      # Pantry — shared

      Types and helpers the web app and the API both use: money, quantities,
      recipes and meal plans.
    `,
    'src/index.ts': sharedIndex(['money']),
    'src/money.ts': moneyV1,
  }),
  commit('mei', '2026-08-06 13:25', 'Add Quantity with unit conversion', {
    'src/quantity.ts': text`
      export type Unit = 'g' | 'kg' | 'ml' | 'l' | 'item';

      export interface Quantity {
        readonly amount: number;
        readonly unit: Unit;
      }

      const BASE: Record<Unit, [Unit, number]> = { g: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], l: ['ml', 1000], item: ['item', 1] };

      /** The same quantity in grams, millilitres or items. */
      export function toBase(q: Quantity): Quantity {
        const [unit, factor] = BASE[q.unit];
        return { amount: q.amount * factor, unit };
      }
    `,
    'src/index.ts': sharedIndex(['money', 'quantity']),
  }),
  commit('samir', '2026-08-11 17:10', 'Add Recipe and Ingredient types', {
    'src/recipe.ts': text`
      import type { Quantity } from './quantity.js';

      export interface Ingredient {
        readonly name: string;
        readonly quantity: Quantity;
      }

      export interface Recipe {
        readonly id: string;
        readonly title: string;
        readonly minutes: number;
        readonly servings: number;
        readonly ingredients: readonly Ingredient[];
      }
    `,
    'src/index.ts': sharedIndex(['money', 'quantity', 'recipe']),
  }),
  commit('mei', '2026-08-12 10:40', 'Multiply money with banker’s rounding', {
    'src/money.ts': moneyV2,
    'test/money.test.ts': text`
      import { describe, expect, it } from 'vitest';
      import { money, multiply } from '../src/money.js';

      describe('multiply', () => {
        it('rounds a half cent to the even neighbour', () => {
          expect(multiply(money(0.05), 0.5).cents).toBe(2);
          expect(multiply(money(0.07), 0.5).cents).toBe(4);
        });
      });
    `,
  }),
  tag('v0.1.0', 'mei', '2026-08-13 09:00'),
  commit('diego', '2026-08-25 15:30', 'Validate servings and ingredient amounts', {
    'src/validation.ts': text`
      import type { Recipe } from './recipe.js';

      export function recipeProblems(recipe: Recipe): string[] {
        const problems: string[] = [];
        if (!Number.isInteger(recipe.servings) || recipe.servings < 1) problems.push('servings must be a whole number above 0');
        for (const ingredient of recipe.ingredients) {
          if (ingredient.quantity.amount <= 0) problems.push(\`\${ingredient.name}: the amount must be above 0\`);
        }
        return problems;
      }
    `,
    'src/index.ts': sharedIndex(['money', 'quantity', 'recipe', 'validation']),
  }),
  commit('mei', '2026-09-02 11:55', 'Support US customary units', {
    'src/quantity.ts': text`
      export type Unit = 'g' | 'kg' | 'ml' | 'l' | 'item' | 'oz' | 'lb' | 'cup' | 'tbsp' | 'tsp';

      export interface Quantity {
        readonly amount: number;
        readonly unit: Unit;
      }

      const BASE: Record<Unit, [Unit, number]> = {
        g: ['g', 1],
        kg: ['g', 1000],
        oz: ['g', 28.3495],
        lb: ['g', 453.592],
        ml: ['ml', 1],
        l: ['ml', 1000],
        cup: ['ml', 236.588],
        tbsp: ['ml', 14.7868],
        tsp: ['ml', 4.92892],
        item: ['item', 1],
      };

      /** The same quantity in grams, millilitres or items. */
      export function toBase(q: Quantity): Quantity {
        const [unit, factor] = BASE[q.unit];
        return { amount: q.amount * factor, unit };
      }
    `,
    'test/quantity.test.ts': text`
      import { describe, expect, it } from 'vitest';
      import { toBase } from '../src/quantity.js';

      describe('toBase', () => {
        it('turns a cup into millilitres', () => {
          expect(toBase({ amount: 1, unit: 'cup' }).amount).toBeCloseTo(236.588);
        });
      });
    `,
  }),
  tag('v0.2.0', 'mei', '2026-09-03 09:30'),
  commit('ava', '2026-09-15 10:15', 'Format money with Intl.NumberFormat', { 'src/money.ts': moneyV3 }),
  branch('feature/currency-display'),
  commit('samir', '2026-10-01 14:45', 'Add MealPlan and PlannedMeal types', {
    'src/plan.ts': text`
      export type Slot = 'breakfast' | 'lunch' | 'dinner';

      export interface PlannedMeal {
        readonly day: number;
        readonly slot: Slot;
        readonly recipeId: string;
        readonly servings: number;
      }

      export interface MealPlan {
        /** ISO week, such as 2026-W43. */
        readonly week: string;
        readonly meals: readonly PlannedMeal[];
      }
    `,
    'src/index.ts': sharedIndex(['money', 'quantity', 'recipe', 'validation', 'plan']),
  }),
  checkout('feature/currency-display'),
  commit('mei', '2026-10-06 09:35', 'Show compact amounts on small screens', { 'src/money.ts': moneyTheirs1 }),
  commit('mei', '2026-10-09 16:15', 'Add isZero for empty totals', { 'src/money.ts': moneyTheirs2 }),
  checkout('main'),
  commit('ava', '2026-10-10 11:05', 'Format money in the user’s locale', { 'src/money.ts': moneyOurs }),
  tag('v0.3.0', 'ava', '2026-10-10 11:10'),
  push('main', 'main'),
  push('feature/currency-display', 'feature/currency-display'),
  { op: 'pushTags' },
  { op: 'fetch' },
  track('main'),
  track('feature/currency-display'),
];

/** @type {Record<string, Step[]>} */
export const HISTORY = { api, shared, web };

/** Changes left uncommitted once the history is written. */
export const WORKING_TREE = {
  web: {
    'src/cart/totals.ts': totalsWorking,
    'src/planner/WeekView.tsx': weekView(5),
    'src/planner/usePlanner.ts': usePlanner(5),
    'src/planner/MealCard.tsx': mealCard,
    'vite.config.ts': viteConfig(true),
  },
  api: {
    'src/routes/plans.ts': plansRoute(3),
    'src/db/migrations/0004_plan_notes.sql': text`
      alter table planned_meals add column note text;
    `,
  },
};

/** The branch shared's merge scene merges into main, and the file it conflicts in. */
export const CONFLICT = { repo: 'shared', branch: 'feature/currency-display', file: 'src/money.ts' };

/** The file the diff and blame scenes open. */
export const SHOWCASE_FILE = { repo: 'web', file: 'src/cart/totals.ts' };
