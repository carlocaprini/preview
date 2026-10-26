# Product Definition — Preview

> **Stato:** DRAFT · **Versione:** 0.1 · **Ultimo aggiornamento:** 2026-10-26  
> **Repository:** `carlocaprini/preview`  
> **Fase:** Product discovery, prima di specification, technical design e implementazione.

## 0. Come leggere e aggiornare questo documento

Questa è la **fonte di verità per la definizione del prodotto**. Non è ancora una specifica tecnica e **non autorizza Codex a implementare**.

Ogni affermazione significativa è distinta per stato:
- **CONFERMATO**: espresso e concordato esplicitamente dal product owner.
- **PREFERENZA**: direzione dichiarata, ma ancora da precisare.
- **PROPOSTA**: suggerimento emerso nella discussione, non ancora approvato.
- **APERTO**: richiede una decisione o un approfondimento.

Le decisioni successive aggiornano le sezioni pertinenti, il *Decision Log* e il *Changelog*. Se una decisione cambia, si conserva lo storico e si esplicita la modifica. Non si trasforma un'ipotesi in requisito senza conferma.

## 1. Visione e problema

### Product statement (bozza)

Un servizio leggero per caricare documenti, condividerli mediante link con clienti o prospect e osservare segnali attendibili di consultazione, senza dover gestire manualmente pubblicazione dei file e infrastruttura di tracking.

### Problema

Quando si invia un documento a un cliente/prospect attraverso un normale allegato o un link a un file, manca visibilità su:
- se il collegamento è stato aperto;
- quante volte e quando viene visitato;
- quanto e quali parti del documento sono state effettivamente visualizzate;
- se l'accesso possa aver coinvolto altre persone.

L'assenza di queste informazioni rende più difficile capire se il documento è arrivato e orientare follow-up o miglioramenti del materiale. **Attenzione:** una visita non equivale a lettura, una lettura non equivale a interesse commerciale, e un secondo accesso non dimostra un inoltro.

### Opportunità immediata

**CONFERMATO**: costruire e sperimentare una soluzione propria, definita prima con approccio spec-driven, affidando successivamente l'implementazione a Codex.  
**PREFERENZA**: una soluzione economicamente sostenibile, idealmente entro i tier gratuiti, senza un VPS dedicato se non necessario.

### Opportunità futura (PROPOSTA, non scope)

Potenziale toolkit per consulenti, eventuale prodotto pubblico o componente integrabile in workflow/automazioni agentiche. Non assumere fin da ora monetizzazione, multi-tenancy o CRM.

## 2. Utenti e contesti

- **Owner / amministratore** — persona che carica, organizza e condivide documenti, consulta segnali di visualizzazione e può eventualmente revocare i link. **PROPOSTA**: inizialmente un solo account amministratore.
- **Destinatario** — cliente/prospect che riceve il link e vuole leggere il documento con il minimo attrito possibile.
- **Secondo lettore** — chi riceve eventualmente il link da altri. La sua identità e l'esistenza di un inoltro non sono automaticamente osservabili.

### Jobs to be done

1. *Quando preparo un documento per un prospect, voglio renderlo disponibile con un collegamento facilmente condivisibile, così da evitare invii e aggiornamenti manuali di file.*
2. *Quando invio il documento, voglio vedere se e quando il link è stato visitato, così da capire se ha raggiunto il destinatario e contestualizzare un eventuale follow-up.*
3. *Quando qualcuno consulta il documento, voglio distinguere il semplice caricamento della pagina dall'interazione nel viewer, per non interpretare falsamente bot o preview automatiche come letture.*
4. *Quando un link circola oltre il destinatario iniziale, voglio riconoscere i segnali di accesso aggiuntivo, senza attribuire identità o inoltri che non posso verificare.*

## 3. Obiettivi e criteri di successo da definire

### Obiettivi qualitativi (CONFERMATI / coerenti con la richiesta)

- Caricare documenti senza un nuovo deploy del sito.
- Creare un link utilizzabile da clienti e prospect.
- Consultare data, orario e numero di accessi/visualizzazioni.
- Comprendere, nei limiti osservabili, se un documento è stato condiviso ulteriormente.
- Ridurre manutenzione e costi infrastrutturali.

### Metriche di successo (APERTE)

- Tempo dalla selezione del file alla creazione di un link funzionante.
- Accuratezza e comprensibilità della distinzione tra visita tecnica e lettura interattiva.
- Utilità delle statistiche per un follow-up reale.
- Affidabilità del link in diversi browser e dispositivi.
- Costo mensile effettivo ai volumi attesi e manutenzione necessaria.

Nessuna soglia numerica è stata ancora approvata.

## 4. Capacità funzionali: richieste, proposte e limiti

| ID | Capacità | Stato | Note |
| --- | --- | --- | --- |
| CAP-01 | Caricare un documento e renderlo gestibile | CONFERMATO | PDF come primo formato; altri tipi possibili in futuro |
| CAP-02 | Creare un link condivisibile con clienti/prospect | CONFERMATO | Da dettagliare: nominativo, generico o entrambi |
| CAP-03 | Rilevare apertura/visita al link | CONFERMATO | Va definito cosa conti come apertura |
| CAP-04 | Mostrare numero e data/ora degli accessi | CONFERMATO | Sessioni e visitatori non sono sinonimi |
| CAP-05 | Osservare possibili condivisioni ulteriori | CONFERMATO come desiderio | Inferenza limitata; tracking certo dell'inoltro non garantibile |
| CAP-06 | Viewer PDF incorporato | PROPOSTA | Necessario se si vogliono eventi pagina per pagina attendibili |
| CAP-07 | Tracciare pagine viste, completamento e tempo attivo stimato | PROPOSTA | Granularità e accuratezza da concordare |
| CAP-08 | Creare più link per lo stesso documento | PROPOSTA | Utile per attribuire sessioni al link/contesto |
| CAP-09 | Elenco documenti e analytics per documento/link | PROPOSTA | Da definire layout e filtri |
| CAP-10 | Revocare/scadenzare link e controllare download | PROPOSTA | Necessità e semantica da validare |
| CAP-11 | Sostituire o versionare un documento senza perdere link/storico | PROPOSTA | Da chiarire prima del data model |
| CAP-12 | Notifiche di lettura, API, webhook | FUTURO PROPOSTO | Non assumere MVP |
| CAP-13 | Conversione Office, data room, firme elettroniche, CRM | NON PREVISTO nel primo esperimento (proposta) | Revisione possibile, ma fuori dal focus attuale |

## 5. Flussi iniziali da specificare

### F1 — Pubblicazione

1. L'amministratore accede all'applicazione.
2. Carica un PDF.
3. Ottiene una pagina di gestione e crea un link da condividere.
4. Il destinatario può aprire il link senza dipendere da nuovi deployment del sito.

**Da decidere**: metadata, naming, limiti, errori, accessi, upload multipli, privacy.

### F2 — Consultazione

1. Il destinatario apre il link.
2. Il sistema verifica che il link consenta l'accesso.
3. Mostra il documento su un'interfaccia utilizzabile anche da mobile.
4. Registra gli eventi consentiti e li attribuisce a quel collegamento, quando possibile.

**Da decidere**: accesso anonimo o identificato, download, pagine, sessioni, consenso e informativa.

### F3 — Analisi

1. L'amministratore apre il dettaglio del documento.
2. Vede accessi e cronologia, con distinzione esplicita tra evento HTTP, sessione e interazione reale.
3. Può identificare segnali di accessi ripetuti o ulteriori, evitando conclusioni certe sull'identità.

**Da decidere**: aggregazioni, filtri, durata del dato, notifiche, bot detection.

### F4 — Documento inoltrato

1. Il destinatario principale condivide il link con un'altra persona (fuori dal controllo dell'app).
2. Un'altra sessione apre il link.
3. L'amministratore vede il nuovo accesso, ma **non** un evento di inoltro verificato.

**Da decidere**: etichette e indicatori nella UI; verifica email opzionale; livello di identificazione accettabile.

## 6. Principi e vincoli

- **Prima il prodotto, poi l'implementazione (CONFERMATO).** Product Definition, specifiche e architettura vanno chiarite prima che Codex implementi.
- **Link fruibili esternamente (CONFERMATO).** Il lettore non deve dipendere dalla rete privata dell'owner.
- **Minimo overhead operativo (PREFERENZA).** Preferenza per hosting statico/serverless rispetto a gestire una VPS.
- **Costi bassi o nulli (PREFERENZA).** Un free tier è un obiettivo, non un diritto garantito né un requisito tecnico assoluto.
- **Analytics onesti (PROPOSTA).** Non presentare accessi, tempo visibile o indirizzi IP come prova certa di lettura o inoltro.
- **Privacy e sicurezza per design (NECESSITÀ DI PROGETTO).** Storage privato, controlli di accesso, protezione dei link, minimizzazione dei dati e disciplina dei tempi di conservazione; aspetti legali da verificare prima della pubblicazione.
- **Evolvibilità (PROPOSTA).** Non complicare l'MVP per esigenze di un ipotetico SaaS multiutente.

## 7. Alternative tecniche — ancora non deliberate

Dalla valutazione iniziale:
- **Opzione preferita da approfondire:** frontend statico + funzioni serverless + storage e database gestiti (esempio: Cloudflare Pages, Workers, R2, D1).
- **Opzione alternativa:** VPS/self-hosting per esigenze più pesanti o dipendenze tecniche incompatibili.
- **Opzione senza sviluppo custom:** prodotti esistenti come Papermark/DocSend, utili anche come riferimento UX.

**Nessun provider, linguaggio, framework o servizio è vincolato dalla Product Definition.** Una web app con operazioni di upload e tracking non può essere letteralmente solo statica senza componenti dinamici o servizi esterni.

## 8. Decision log

| ID | Data | Decisione / orientamento | Stato |
| --- | --- | --- | --- |
| D-001 | 2026-10-26 | Sperimentare la costruzione di un servizio proprio di document sharing/tracking | CONFERMATO |
| D-002 | 2026-10-26 | Seguire un processo spec-driven e affidare a Codex l'implementazione **dopo** aver definito e approvato i requisiti | CONFERMATO |
| D-003 | 2026-10-26 | Usare `carlocaprini/preview` per conservare e aggiornare la Product Definition | CONFERMATO |
| D-004 | 2026-10-26 | PDF come primo caso d'uso, con eventuali altri documenti in seguito | PREFERENZA |
| D-005 | 2026-10-26 | Preferire deploy gratuito e bassa manutenzione; valutare serverless prima di VPS | PREFERENZA |
| D-006 | 2026-10-26 | Un solo admin, viewer PDF, link nominativi, analytics pagina per pagina | PROPOSTA NON APPROVATA |

## 9. Questioni aperte — agenda di discovery

Le questioni sono ordinate per dipendenze di prodotto, non per priorità implementativa.

| ID | Tema | Domanda di prodotto | Impatto |
| --- | --- | --- | --- |
| Q-01 | Modello di condivisione | Un link generico per documento, link nominativi per prospect, oppure entrambi? | Identità, UX, modello dati |
| Q-02 | Frizione del lettore | Aprire direttamente o richiedere email/OTP o password in casi selezionati? | Attribuzione, conversione, privacy |
| Q-03 | Semantica dei dati | Cosa chiamiamo apertura, visita, sessione, lettura, completamento? | Fiducia nelle metriche |
| Q-04 | Segnali di inoltro | Quali informazioni sono davvero utili e con quale livello di certezza dichiarato? | Tracking, rischio di false conclusioni |
| Q-05 | Esperienza lettore | Solo viewer? Download, stampa, mobile, accessibilità? | Prodotto e limiti di tracking |
| Q-06 | Lifecycle | Scadenza, revoca, aggiornamento/versioni e cancellazione dei file? | Gestione e sicurezza |
| Q-07 | Analytics | Aggregati vs timeline, pagine, tempo visibile, notifiche, esportazione? | Complessità MVP |
| Q-08 | Privacy | Dati minimi, retention, trasparenza al lettore e base giuridica? | Requisiti di release |
| Q-09 | Admin | Accesso singolo, organizzazione/ricerca, volume tipico di documenti e destinatari? | Scope UX |
| Q-10 | Product distribution | Uso personale soltanto o preparazione fin dall'inizio a un prodotto pubblico? | Architettura e scope |
| Q-11 | Infra e budget | Quali limiti di costo e disponibilità rendono accettabile la soluzione? | Technical design |
| Q-12 | Brand | Dominio personalizzato e branding già nella prima versione? | UX e deployment |

## 10. Rischi e assunzioni

- Preview automatiche dei client email e scanner di sicurezza possono generare aperture senza coinvolgimento umano.
- Eventi client-side persi, tab in background o blocco degli script influenzano la stima della lettura.
- Un link inoltrato conserva di default lo stesso contesto: non garantisce identificazione di chi accede.
- File scaricati o copie/screenshot non sono monitorabili dopo la distribuzione.
- Tracking individuale di prospect può implicare obblighi privacy diversi dagli analytics aggregati di un sito.
- Quote gratuite e prezzi cloud sono soggetti a modifiche: da verificare durante il technical design.

## 11. Processo di approvazione

1. **Product Definition — IN DISCUSSIONE**: chiudere questioni Q-01–Q-12, formalizzare le decisioni e rivedere gli obiettivi.
2. **Product Definition — APPROVATA**: freeze della direzione e scope MVP.
3. **Functional specs**: casi d'uso, comportamenti, edge case, acceptance criteria verificabili.
4. **Technical design / ADR**: alternative, architettura, dati, API, costi, sicurezza e operazioni.
5. **Readiness review**: coerenza tra requisiti e piano; issue per unità di lavoro.
6. **Codex**: implementazione soltanto dopo autorizzazione esplicita. PR piccole e verifica rispetto alle specifiche.

## 12. Changelog

- **2026-10-26 — v0.1**: creata prima Product Definition sulla base della discussione iniziale; separati fatti confermati, preferenze, proposte e punti aperti. Nessuna decisione implementativa o architetturale approvata.
