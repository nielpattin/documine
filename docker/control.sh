#!/bin/bash

set -e

project=documine

printHelp () {
	echo "Usage: control.sh <command>"
	echo "Available commands:"
	echo
	echo "   start        Builds docker images and starts the production stack."
	echo "   startdev     Builds docker images and starts the local stack (API 3120, web 5175)."
	echo "   stop         Stops the stack."
	echo "   logs         Tail -f stack logs."
	echo "   shell        Opens a shell into the api container."
}

dir="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"
pushd $dir > /dev/null

mkdir -p data/notes

case "$1" in
start)
	docker compose -p $project -f docker-compose.base.yml -f docker-compose.prod.yml build
	docker compose -p $project -f docker-compose.base.yml -f docker-compose.prod.yml up -d
	;;
startdev)
	docker compose -p $project -f docker-compose.base.yml down -t 1
	docker compose -p $project -f docker-compose.base.yml -f docker-compose.dev.yml build
	docker compose -p $project -f docker-compose.base.yml -f docker-compose.dev.yml up
	;;
stop)
	docker compose -p $project -f docker-compose.base.yml down -t 1
	;;
shell)
	docker exec -it ${project}_api sh
	;;
logs)
	docker compose -p $project -f docker-compose.base.yml logs -f
	;;
*)
	echo "Invalid command $1"
	printHelp
	;;
esac

popd > /dev/null
