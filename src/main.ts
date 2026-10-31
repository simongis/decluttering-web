import '@esri/calcite-components/dist/calcite/calcite.css';
import { setAssetPath } from '@esri/calcite-components/dist/components';
import '@esri/calcite-components/dist/components/calcite-shell';
import '@esri/calcite-components/dist/components/calcite-navigation';
import '@esri/calcite-components/dist/components/calcite-button';
import './styles/tokens.css';
import './styles/app.css';
import './styles/scan.css';
import './styles/skin-console.css';
import { applySkin, currentSkin } from './ui/skin/skin';
import { initLocale } from './i18n';

// The saved or browser language is loaded before the app renders, so the first paint is already in that language.
void initLocale().finally(() => import('./app-root'));

setAssetPath('https://js.arcgis.com/calcite-components/3.3.3/assets');
// DC-135 (ADR 0014): the console look, when this browser chose it. The standard look needs nothing.
if (currentSkin() === 'console') applySkin('console');
