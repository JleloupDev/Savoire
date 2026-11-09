// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Contenu d'un document .tex neuf : de quoi voir tout de suite ce que
// l'apercu sait afficher.

export const LATEX_TEMPLATE = String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{amsmath}
\title{Nouveau document}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
Ce document s'écrit à plusieurs, en même temps. L'aperçu suit chaque frappe.
Une formule dans le texte : $E = mc^2$, ou $\sqrt{a^2 + b^2}$.

\begin{equation}
  \int_0^{+\infty} e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
  \label{eq:gauss}
\end{equation}

L'équation~\eqref{eq:gauss} est l'intégrale de Gauss.

\subsection{Une liste}
\begin{itemize}
  \item \textbf{gras}, \emph{italique}, \texttt{code} ;
  \item une somme : $\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$.
\end{itemize}

\end{document}
`
