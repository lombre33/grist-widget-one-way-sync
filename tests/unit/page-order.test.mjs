// Où va la page du formulaire d'une réception dans le menu de gauche de Grist : juste sous la page de la
// table qui reçoit, après ses sous-pages, au même niveau ; jamais déplacée si elle y est déjà.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destPageViews, placeBelow } from '../../js/engine/logic/page-order.js';

const page = (viewRef, pagePos, indentation = 0) => ({ id: viewRef * 10, viewRef, pagePos, indentation });

test('placeBelow : entre la page de la table et la suivante, à son niveau', () => {
  const pages = [page(1, 1), page(2, 2), page(3, 3), page(9, 4)]; // 9 = le formulaire, en fin de liste
  assert.deepEqual(placeBelow(pages, [2], 9), { pagePos: 2.5, indentation: 0 });
  assert.deepEqual(placeBelow(pages, [1], 9), { pagePos: 1.5, indentation: 0 });
});

test('placeBelow : après les sous-pages de la table, pas entre elle et ses filles', () => {
  const pages = [page(1, 1), page(2, 2), page(3, 3, 1), page(4, 4, 1), page(5, 5), page(9, 6)];
  assert.deepEqual(placeBelow(pages, [2], 9), { pagePos: 4.5, indentation: 0 });
  // Une table qui est elle-même une sous-page : la page se met à son niveau.
  assert.deepEqual(placeBelow(pages, [3], 9), { pagePos: 3.5, indentation: 1 });
});

test('placeBelow : plusieurs tables, sous la plus basse', () => {
  const pages = [page(1, 1), page(2, 2), page(3, 3), page(4, 4), page(9, 5)];
  assert.deepEqual(placeBelow(pages, [1, 3], 9), { pagePos: 3.5, indentation: 0 });
  assert.deepEqual(placeBelow(pages, [3, 1], 9), { pagePos: 3.5, indentation: 0 });
  // Une réception créée avec ses tables neuves : leurs pages viennent d'être créées, la page du formulaire
  // est déjà dessous, rien ne bouge.
  assert.equal(placeBelow([page(1, 1), page(2, 2), page(3, 3), page(9, 4)], [2, 3], 9), null);
});

test('placeBelow : rien à faire quand la page y est déjà ou qu\'aucune table n\'a de page', () => {
  assert.equal(placeBelow([page(1, 1), page(9, 2), page(2, 3)], [1], 9), null, 'déjà juste dessous');
  assert.deepEqual(placeBelow([page(1, 1), page(9, 2, 1)], [1], 9), { pagePos: 2, indentation: 0 }, 'dessous mais en sous-page : remise au niveau de la table');
  assert.equal(placeBelow([page(1, 1), page(2, 2), page(9, 3)], [], 9), null);
  assert.equal(placeBelow([page(1, 1), page(2, 2), page(9, 3)], [7], 9), null, 'une vue qui n\'est pas dans la liste');
});

test('placeBelow : la dernière page de la liste, la page vient après', () => {
  assert.deepEqual(placeBelow([page(9, 1), page(1, 2)], [1], 9), { pagePos: 3, indentation: 0 });
});

test('destPageViews : la page propre de la table, sinon la première page de la liste qui la montre', () => {
  const tables = [{ id: 1, tableId: 'A', primaryViewId: 11 }, { id: 2, tableId: 'B', primaryViewId: 0 }, { id: 3, tableId: 'C', primaryViewId: 13 }];
  const sections = [{ id: 1, tableRef: 2, parentId: 20 }, { id: 2, tableRef: 2, parentId: 21 }, { id: 3, tableRef: 3, parentId: 99 }];
  const pages = [page(11, 1), page(20, 2), page(21, 3)];
  assert.deepEqual(destPageViews(['A', 'B'], tables, sections, pages), [11, 20]);
  assert.deepEqual(destPageViews(['C', 'Z'], tables, sections, pages), [], 'C n\'a plus sa page ; Z n\'existe pas');
});
