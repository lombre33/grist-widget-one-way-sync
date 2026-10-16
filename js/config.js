// Seul réglage du widget : les instances Grist d'où il charge l'API des widgets. Une instance qui
// héberge sa propre copie ajoute son adresse ici ET dans la politique de sécurité (balise
// Content-Security-Policy de index.html), aux mêmes endroits.
export const GRIST_ORIGINS = ['https://grist.numerique.gouv.fr', 'https://docs.getgrist.com'];

// Adresse officielle du widget, donnée dans les consignes à transmettre (jamais l'adresse d'où
// cette copie est servie : une copie piégée se ferait recommander). Une instance qui héberge sa
// propre copie, ou la publie dans sa galerie de widgets, met ici son adresse.
export const WIDGET_URL = 'https://grist-factory.github.io/grist-widget-syncPlus/';

export const VERSION = '0.8.0';
