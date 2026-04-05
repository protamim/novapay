FROM oven/bun:1
WORKDIR /app
COPY package.json bunfig.toml ./
RUN bun install
COPY . .

EXPOSE 3000
CMD ["sh", "-c", "bun run migrate && bun run start"]
