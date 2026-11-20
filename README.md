# Caixa da Barbearia

App de celular para o barbeiro registrar cortes e vendas de produtos e ver o faturamento por dia, semana, mês e semestre. Funciona no navegador e pode ser instalado na tela inicial (PWA).

## Como está montado

- Site estático (HTML, CSS e JavaScript, sem build), publicado pelo GitHub Pages.
- Login e banco de dados no [Supabase](https://supabase.com) (plano grátis).
- Cada conta só vê os próprios dados (Row Level Security).

| Arquivo | O que é |
|---|---|
| `index.html`, `style.css`, `app.js` | o app |
| `config.js` | URL do projeto Supabase e a chave pública (anon/publishable) |
| `supabase/schema.sql` | tabelas, regras de acesso e funções de venda |
| `manifest.webmanifest`, `sw.js`, `icons/` | instalação no celular |
| `vendor/` | biblioteca do Supabase (supabase-js 2.119.0) |

## Configuração (uma vez)

1. **Banco:** no Supabase, abra *SQL Editor → New query*, cole o conteúdo de `supabase/schema.sql` e clique em *Run*.
2. **Chave:** em *Project Settings → API Keys*, copie a chave *anon public* (ou *publishable*) para `config.js`. Nunca coloque a chave *service_role/secret* no app.
3. **Endereço do site:** em *Authentication → URL Configuration*, coloque o endereço do GitHub Pages em *Site URL* (é para onde o link de confirmação de e-mail leva).
4. **Publicar:** no GitHub, *Settings → Pages → Build and deployment*: *Deploy from a branch*, branch `main`, pasta `/ (root)`.
5. **Fechar cadastro:** depois de criar a conta do barbeiro, desligue *Allow new users to sign up* em *Authentication → Sign In / Providers*, para ninguém mais criar conta no seu projeto.

## Instalar no celular

Abra o site no celular e:
- **iPhone (Safari):** botão Compartilhar → *Adicionar à Tela de Início*.
- **Android (Chrome):** menu ⋮ → *Instalar app* ou *Adicionar à tela inicial*.

## Uso

- **Caixa:** total do dia e botões para registrar serviço ou venda de produto.
- **Relatórios:** Dia, Semana, Mês ou Semestre, com comparação com o período anterior.
- **Produtos:** estoque, aviso de reposição e ajuste com − e +. A venda baixa o estoque e apagar o lançamento devolve.
- **Serviços:** nomes e preços dos serviços, dados de exemplo e sair da conta.
